import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { nuvemshopToolpack } from "@/modules/integrations/toolpacks/nuvemshop";
import type {
  IntegrationSelection,
  ToolpackCtx,
} from "@/modules/integrations/toolpacks/types";

function stubFetch(status: number, json: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(json), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const noopAssert = async () => undefined;

function baseCtx(over: Partial<ToolpackCtx> = {}): ToolpackCtx {
  return {
    tenantId: 1n,
    base: undefined as unknown as PrismaClient,
    threadId: "1:1:1",
    resolveCredential: async () => "tok_live",
    assertSafe: noopAssert,
    ...over,
  };
}

function sel(over: Partial<IntegrationSelection> = {}): IntegrationSelection {
  return {
    instanceId: 1n,
    catalogType: "NUVEMSHOP",
    config: { storeId: "123456" },
    credentialRef: "nuvemshop-token",
    enabledTools: [],
    ...over,
  };
}

describe("nuvemshop toolpack — allowlist (fail-closed)", () => {
  test("empty allowlist → no tools", () => {
    expect(
      nuvemshopToolpack.build(sel({ enabledTools: [] }), baseCtx()),
    ).toEqual([]);
  });

  test("only allowlisted tools are exposed", () => {
    const tools = nuvemshopToolpack.build(
      sel({ enabledTools: ["nuvemshop_order_lookup"] }),
      baseCtx(),
    );
    expect(tools.map((t) => t.name)).toEqual(["nuvemshop_order_lookup"]);
  });
});

describe("nuvemshop_order_lookup", () => {
  test("summarizes matching orders and hits the correct URL/headers", async () => {
    const { impl, calls } = stubFetch(200, [
      {
        id: 871254203,
        number: 1023,
        status: "open",
        payment_status: "paid",
        shipping_status: "shipped",
        contact_name: "Maria Silva",
        total: "199.90",
        currency: "BRL",
        created_at: "2026-07-01T10:00:00-03:00",
      },
    ]);
    const tools = nuvemshopToolpack.build(
      sel({ enabledTools: ["nuvemshop_order_lookup"] }),
      baseCtx({ fetchImpl: impl }),
    );
    const out = await tools[0]?.invoke({ query: "1023" });
    expect(String(out)).toContain("Order #1023");
    expect(String(out)).toContain("payment: paid");
    expect(String(out)).toContain("shipping: shipped");
    expect(calls[0]?.url).toStartWith(
      "https://api.nuvemshop.com.br/2025-03/123456/orders?",
    );
    expect(calls[0]?.url).toContain("q=1023");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok_live");
    expect(headers["User-Agent"]).toBeTruthy();
  });

  test("no matches → clear message, no crash", async () => {
    const { impl } = stubFetch(200, []);
    const tools = nuvemshopToolpack.build(
      sel({ enabledTools: ["nuvemshop_order_lookup"] }),
      baseCtx({ fetchImpl: impl }),
    );
    const out = await tools[0]?.invoke({ query: "no-such-order" });
    expect(String(out)).toContain("No order found");
  });

  test("missing storeId → declines without a network call", async () => {
    const { impl, calls } = stubFetch(200, []);
    const tools = nuvemshopToolpack.build(
      sel({ enabledTools: ["nuvemshop_order_lookup"], config: {} }),
      baseCtx({ fetchImpl: impl }),
    );
    const out = await tools[0]?.invoke({ query: "1023" });
    expect(String(out)).toContain("not fully configured");
    expect(calls.length).toBe(0);
  });
});

describe("nuvemshop_product_search", () => {
  test("summarizes matching products (price range + stock)", async () => {
    const { impl, calls } = stubFetch(200, [
      {
        id: 1234,
        name: { pt: "Master Ball", es: "Master Ball", en: "Master Ball" },
        variants: [
          { price: "25.00", stock: 5, stock_management: true },
          { price: "30.00", stock: 0, stock_management: true },
        ],
      },
    ]);
    const tools = nuvemshopToolpack.build(
      sel({ enabledTools: ["nuvemshop_product_search"] }),
      baseCtx({ fetchImpl: impl }),
    );
    const out = await tools[0]?.invoke({ query: "master ball" });
    expect(String(out)).toContain("Master Ball");
    expect(String(out)).toContain("25.00");
    expect(String(out)).toContain("in stock");
    expect(calls[0]?.url).toStartWith(
      "https://api.nuvemshop.com.br/2025-03/123456/products?",
    );
  });

  test("out-of-stock-only variants → reports out of stock", async () => {
    const { impl } = stubFetch(200, [
      {
        id: 1,
        name: { pt: "Sold Out Item" },
        variants: [{ price: "10.00", stock: 0, stock_management: true }],
      },
    ]);
    const tools = nuvemshopToolpack.build(
      sel({ enabledTools: ["nuvemshop_product_search"] }),
      baseCtx({ fetchImpl: impl }),
    );
    const out = await tools[0]?.invoke({ query: "sold out" });
    expect(String(out)).toContain("out of stock");
  });

  test("store rejects (HTTP error) → surfaces status, no throw", async () => {
    const { impl } = stubFetch(401, { message: "invalid token" });
    const tools = nuvemshopToolpack.build(
      sel({ enabledTools: ["nuvemshop_product_search"] }),
      baseCtx({ fetchImpl: impl }),
    );
    const out = await tools[0]?.invoke({ query: "x" });
    expect(String(out)).toContain("HTTP 401");
  });
});
