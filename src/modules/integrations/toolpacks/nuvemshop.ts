import { type StructuredToolInterface, tool } from "@langchain/core/tools";
import { z } from "zod";
import logger from "@/api/lib/logger";
import {
  type IntegrationSelection,
  registerToolpack,
  type Toolpack,
  type ToolpackCtx,
  type ToolSpec,
} from "./types";

// Nuvemshop/Tiendanube OUTBOUND toolpack — read-only order lookup + product search for WhatsApp
// customer service ("cadê meu pedido?", "vocês têm isso?"). No inbound support yet: unlike Asaas
// (where our own toolpack generates the payment link and can stamp an opaque correlation token),
// a Nuvemshop order is normally created on the STORE'S OWN checkout, not by our agent — correlating
// an order/paid webhook back to a WhatsApp thread would need to match by customer phone/email
// against our Contact table, a materially different (and still PK-based, not LLM) design left for
// a follow-up. See docs/integrations.md.
//
// Auth: OAuth 2.0 authorization_code, but per Tiendanube's docs (tiendanube.github.io/api-
// documentation/authentication, checked 2026-08) the resulting access_token NEVER expires — so,
// like Asaas, it is stored as a plain static Bearer credential in the vault; no refresh dance.
// Obtaining it requires a registered Tiendanube/Nuvemshop Partner "app" (client_id/secret) and a
// one-time authorization_code exchange per store — done once, out of band, by the operator; this
// toolpack only ever consumes the resulting long-lived access_token.
//
// store_id is NOT a secret (it's the path prefix on every request) — lives in
// IntegrationInstance.config, not the vault.

const TIMEOUT_MS = 12_000;
const MAX_RESPONSE_CHARS = 20_000;
const API_VERSION = "2025-03";

// Both domains resolve to the same platform (tiendanube.com / nuvemshop.com.br); nuvemshop.com.br
// is the Brazilian-facing one this product targets.
const NUVEMSHOP_ORIGIN = "https://api.nuvemshop.com.br";

interface NuvemshopResponse {
  status: number;
  json: unknown;
}

function storeIdOf(config: Record<string, unknown>): string | null {
  const raw = config.storeId;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return null;
}

async function nuvemshopFetch(
  storeId: string,
  path: string,
  token: string,
  ctx: ToolpackCtx,
): Promise<NuvemshopResponse> {
  const url = `${NUVEMSHOP_ORIGIN}/${API_VERSION}/${encodeURIComponent(storeId)}${path}`;
  const assertSafe = ctx.assertSafe;
  if (assertSafe) await assertSafe(url);
  const doFetch = ctx.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        // Required by Nuvemshop/Tiendanube — an app identifier + contact; a missing User-Agent
        // gets a 400 (doc-confirmed).
        "User-Agent": "fazer.ai agents (support@fazer.ai)",
      },
      redirect: "error",
      signal: ctrl.signal,
    });
    const text = (await res.text()).slice(0, MAX_RESPONSE_CHARS);
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON body → leave json null; the caller surfaces a generic error
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

// ── order lookup ──

const ORDER_LOOKUP_SCHEMA = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Order number (e.g. '1023'), or the customer's name/email to find their most recent order.",
    ),
});

interface NuvemshopOrderSummary {
  id: number;
  number: number;
  status: string;
  payment_status: string;
  shipping_status: string;
  contact_name?: string;
  total: string;
  currency: string;
  created_at: string;
}

function summarizeOrder(o: NuvemshopOrderSummary): string {
  return [
    `Order #${o.number} (id ${o.id})`,
    `status: ${o.status}, payment: ${o.payment_status}, shipping: ${o.shipping_status}`,
    `total: ${o.total} ${o.currency}`,
    o.contact_name ? `customer: ${o.contact_name}` : null,
    `placed: ${o.created_at}`,
  ]
    .filter(Boolean)
    .join(" | ");
}

function buildOrderLookupTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  return tool(
    async ({ query }: { query: string }) => {
      const storeId = storeIdOf(sel.config);
      const token = sel.credentialRef
        ? await ctx.resolveCredential(sel.credentialRef)
        : null;
      if (!storeId || !token)
        return "Nuvemshop is not fully configured for this integration (missing store id or credential).";

      // A bare number is almost always the order `number` (the sequential, customer-visible id,
      // starts at 100) — search by it via `q`; otherwise `q` free-texts the customer name/email.
      const params = new URLSearchParams({
        q: query,
        per_page: "5",
        fields:
          "id,number,status,payment_status,shipping_status,contact_name,total,currency,created_at",
      });
      let res: NuvemshopResponse;
      try {
        res = await nuvemshopFetch(storeId, `/orders?${params}`, token, ctx);
      } catch (err) {
        logger.warn({ err }, "nuvemshop: order lookup request failed");
        return "Failed to reach the store. Try again shortly.";
      }
      if (res.status < 200 || res.status >= 300) {
        logger.warn(
          "nuvemshop: order lookup returned HTTP %s",
          String(res.status),
        );
        return `The store rejected the request (HTTP ${res.status}).`;
      }
      const rows = Array.isArray(res.json)
        ? (res.json as NuvemshopOrderSummary[])
        : [];
      if (rows.length === 0) return `No order found matching "${query}".`;
      return rows.map(summarizeOrder).join("\n");
    },
    {
      name: "nuvemshop_order_lookup",
      description:
        "Look up orders in the store by order number or by the customer's name/email. Returns status, payment status, and shipping status for up to 5 matches.",
      schema: ORDER_LOOKUP_SCHEMA,
    },
  );
}

// ── product search ──

const PRODUCT_SEARCH_SCHEMA = z.object({
  query: z
    .string()
    .min(1)
    .describe("Product name, tag, or SKU to search for."),
});

interface NuvemshopVariant {
  price?: string;
  promotional_price?: string | null;
  stock?: number | null;
  stock_management?: boolean;
}

interface NuvemshopProduct {
  id: number;
  name?: Record<string, string>;
  variants?: NuvemshopVariant[];
}

function productName(p: NuvemshopProduct): string {
  const n = p.name ?? {};
  return n.pt ?? n.es ?? n.en ?? Object.values(n)[0] ?? `product ${p.id}`;
}

function summarizeProduct(p: NuvemshopProduct): string {
  const variants = p.variants ?? [];
  const prices = variants
    .map((v) => Number(v.promotional_price || v.price))
    .filter((n) => Number.isFinite(n) && n > 0);
  const priceRange =
    prices.length === 0
      ? "price unavailable"
      : Math.min(...prices) === Math.max(...prices)
        ? `${Math.min(...prices).toFixed(2)}`
        : `${Math.min(...prices).toFixed(2)}–${Math.max(...prices).toFixed(2)}`;
  const inStock = variants.some(
    (v) => !v.stock_management || (v.stock ?? 0) > 0,
  );
  return `${productName(p)} (id ${p.id}) — ${priceRange} — ${inStock ? "in stock" : "out of stock"}`;
}

function buildProductSearchTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  return tool(
    async ({ query }: { query: string }) => {
      const storeId = storeIdOf(sel.config);
      const token = sel.credentialRef
        ? await ctx.resolveCredential(sel.credentialRef)
        : null;
      if (!storeId || !token)
        return "Nuvemshop is not fully configured for this integration (missing store id or credential).";

      const params = new URLSearchParams({
        q: query,
        per_page: "5",
        visibility: "visible",
        fields: "id,name,variants",
      });
      let res: NuvemshopResponse;
      try {
        res = await nuvemshopFetch(storeId, `/products?${params}`, token, ctx);
      } catch (err) {
        logger.warn({ err }, "nuvemshop: product search request failed");
        return "Failed to reach the store. Try again shortly.";
      }
      if (res.status < 200 || res.status >= 300) {
        logger.warn(
          "nuvemshop: product search returned HTTP %s",
          String(res.status),
        );
        return `The store rejected the request (HTTP ${res.status}).`;
      }
      const rows = Array.isArray(res.json)
        ? (res.json as NuvemshopProduct[])
        : [];
      if (rows.length === 0) return `No product found matching "${query}".`;
      return rows.map(summarizeProduct).join("\n");
    },
    {
      name: "nuvemshop_product_search",
      description:
        "Search the store's product catalog by name, tag, or SKU. Returns up to 5 matches with price and stock.",
      schema: PRODUCT_SEARCH_SCHEMA,
    },
  );
}

// ── registration ──

const NUVEMSHOP_TOOL_SPECS: ToolSpec[] = [
  { name: "nuvemshop_order_lookup", risk: "low", schema: ORDER_LOOKUP_SCHEMA },
  {
    name: "nuvemshop_product_search",
    risk: "low",
    schema: PRODUCT_SEARCH_SCHEMA,
  },
];

const TOOL_BUILDERS: Record<
  string,
  (sel: IntegrationSelection, ctx: ToolpackCtx) => StructuredToolInterface
> = {
  nuvemshop_order_lookup: buildOrderLookupTool,
  nuvemshop_product_search: buildProductSearchTool,
};

export const nuvemshopToolpack: Toolpack = {
  catalogType: "NUVEMSHOP",
  toolSpecs: NUVEMSHOP_TOOL_SPECS,
  build(sel, ctx) {
    const out: StructuredToolInterface[] = [];
    for (const name of sel.enabledTools) {
      const builder = TOOL_BUILDERS[name];
      if (builder) out.push(builder(sel, ctx));
    }
    return out;
  },
};

registerToolpack(nuvemshopToolpack);
