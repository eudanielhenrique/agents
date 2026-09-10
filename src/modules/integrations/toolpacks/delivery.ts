import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import logger from "@/api/lib/logger";
import { failableTool, toolFailure } from "@/graph/tools/failure";
import {
  calculateDeliveryQuote,
  type DeliveryPricingConfig,
  type UberDirectCredentials,
} from "@/modules/delivery";
import {
  type IntegrationSelection,
  registerToolpack,
  type Toolpack,
  type ToolpackCtx,
  type ToolSpec,
} from "./types";

const CALCULAR_FRETE_SCHEMA = z.object({
  endereco_destino: z
    .string()
    .min(1)
    .describe(
      "Endereço de entrega completo ou bairro de destino (ex: 'Rua Leopoldina Rego, 123, Olaria, Rio de Janeiro' ou 'Madureira, Rio de Janeiro').",
    ),
  endereco_origem: z
    .string()
    .optional()
    .describe(
      "Endereço de saída/origem. Opcional: se omitido, usa automaticamente o endereço padrão configurado da loja.",
    ),
});

function parseCredentials(
  rawSecret: string | null,
): UberDirectCredentials | null {
  if (!rawSecret) return null;
  try {
    const parsed = JSON.parse(rawSecret);
    if (typeof parsed === "object" && parsed !== null) {
      return {
        clientId: String(parsed.clientId || parsed.client_id || ""),
        clientSecret: String(parsed.clientSecret || parsed.client_secret || ""),
        customerId:
          parsed.customerId || parsed.customer_id
            ? String(parsed.customerId || parsed.customer_id)
            : undefined,
        isSandbox: Boolean(parsed.isSandbox ?? parsed.sandbox),
      };
    }
  } catch {
    // If raw string is stored as clientId:clientSecret
    const parts = rawSecret.split(":");
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return {
        clientId: parts[0],
        clientSecret: parts[1],
        customerId: parts[2],
      };
    }
  }
  return null;
}

function buildCalcularFreteTool(
  sel: IntegrationSelection,
  ctx: ToolpackCtx,
): StructuredToolInterface {
  return failableTool(
    async (input: { endereco_destino: string; endereco_origem?: string }) => {
      let credentials: UberDirectCredentials | null = null;
      if (sel.credentialRef) {
        try {
          const rawSecret = await ctx.resolveCredential(sel.credentialRef);
          credentials = parseCredentials(rawSecret);
        } catch (err) {
          logger.warn("delivery: failed to resolve vault credential: %s", err);
        }
      }

      const config: DeliveryPricingConfig = {
        originAddress:
          typeof sel.config.originAddress === "string"
            ? sel.config.originAddress
            : undefined,
        cityDefault:
          typeof sel.config.cityDefault === "string"
            ? sel.config.cityDefault
            : "Rio de Janeiro, RJ",
        pricingMode:
          typeof sel.config.pricingMode === "string"
            ? (sel.config.pricingMode as DeliveryPricingConfig["pricingMode"])
            : "hybrid",
        baseFee:
          typeof sel.config.baseFee === "number"
            ? sel.config.baseFee
            : undefined,
        pricePerKm:
          typeof sel.config.pricePerKm === "number"
            ? sel.config.pricePerKm
            : undefined,
        pricePerMinute:
          typeof sel.config.pricePerMinute === "number"
            ? sel.config.pricePerMinute
            : undefined,
        minimumFee:
          typeof sel.config.minimumFee === "number"
            ? sel.config.minimumFee
            : undefined,
        uberCustomerId:
          typeof sel.config.uberCustomerId === "string"
            ? sel.config.uberCustomerId
            : undefined,
      };

      try {
        const result = await calculateDeliveryQuote(
          {
            destinationAddress: input.endereco_destino,
            originAddress: input.endereco_origem,
          },
          config,
          credentials,
          ctx.fetchImpl ?? fetch,
        );

        return [
          "Resultado do cálculo de frete de entrega:",
          `- Provedor: ${result.provider === "UBER_DIRECT" ? "Uber Direct (Cotação Oficial)" : "Estimativa de Rota (OpenStreetMap / OSRM)"}`,
          `- Endereço de saída (Origem): ${result.originAddress}`,
          `- Endereço de entrega (Destino): ${result.destinationAddress}`,
          `- Distância percorrida: ${result.distanceKm} km`,
          `- Tempo estimado de rota: cerca de ${result.durationMinutes} minutos`,
          `- Valor sugerido do frete / corrida: ${result.formattedPrice}`,
          result.quoteId ? `- Cotação Uber ID: ${result.quoteId}` : null,
          "",
          "Instrução para a resposta ao cliente:",
          "Informe ao cliente o valor aproximado da entrega, o tempo estimado de trajeto e pergunte se ele deseja confirmar o endereço para agendarmos.",
        ]
          .filter(Boolean)
          .join("\n");
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return toolFailure(
          `Não foi possível calcular o frete para "${input.endereco_destino}": ${errMsg}. Por favor, peça ao cliente para confirmar o bairro ou ponto de referência.`,
        );
      }
    },
    {
      name: "calcular_frete_entrega",
      description:
        "Calcula a distância em KM, tempo estimado e valor de entrega/frete para o endereço ou bairro do cliente a partir do endereço da loja (usando Uber Direct oficial ou cálculo por rota OpenStreetMap/OSRM). Use sempre que o cliente perguntar o valor do frete, taxa de entrega ou se entregamos em determinado bairro.",
      schema: CALCULAR_FRETE_SCHEMA,
    },
  );
}

const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "calcular_frete_entrega",
    risk: "low",
    schema: CALCULAR_FRETE_SCHEMA,
  },
];

export const DeliveryToolpack: Toolpack = {
  catalogType: "DELIVERY",
  toolSpecs: TOOL_SPECS,
  build(sel, ctx) {
    const enabled = new Set(sel.enabledTools);
    const tools: StructuredToolInterface[] = [];

    if (enabled.has("calcular_frete_entrega")) {
      tools.push(buildCalcularFreteTool(sel, ctx));
    }

    return tools;
  },
};

registerToolpack(DeliveryToolpack);
