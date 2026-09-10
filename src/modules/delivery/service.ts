import logger from "@/api/lib/logger";
import { calculateFreeDeliveryQuote } from "./osrm";
import type {
  DeliveryPricingConfig,
  DeliveryQuoteInput,
  DeliveryQuoteResult,
  UberDirectCredentials,
} from "./types";
import { calculateUberDirectQuote } from "./uber";

const DEFAULT_ORIGIN_ADDRESS =
  "Av. dos Italianos, 1406 Loja A, Coelho Neto, Rio de Janeiro, RJ";

export async function calculateDeliveryQuote(
  input: DeliveryQuoteInput,
  config: DeliveryPricingConfig = {},
  credentials?: UberDirectCredentials | null,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryQuoteResult> {
  const origin = (
    input.originAddress ||
    config.originAddress ||
    DEFAULT_ORIGIN_ADDRESS
  ).trim();
  const destination = input.destinationAddress.trim();

  if (!destination) {
    throw new Error(
      "Endereço ou bairro de destino é obrigatório para calcular o frete de entrega.",
    );
  }

  const mode = config.pricingMode || "hybrid";

  // 1. Try Uber Direct if mode is hybrid or uber_direct_only AND credentials exist
  if (
    (mode === "hybrid" || mode === "uber_direct_only") &&
    credentials?.clientId &&
    credentials?.clientSecret
  ) {
    try {
      const uberResult = await calculateUberDirectQuote(
        destination,
        origin,
        credentials,
        config,
        fetchImpl,
      );

      if (uberResult) {
        return uberResult;
      }

      if (mode === "uber_direct_only") {
        throw new Error(
          "Cotação com Uber Direct falhou e modo restrito a Uber está configurado.",
        );
      }

      logger.info(
        "Uber Direct quote unavailable, falling back seamlessly to OpenStreetMap/OSRM calculator.",
      );
    } catch (err) {
      if (mode === "uber_direct_only") {
        throw err;
      }
      logger.warn(
        "Uber Direct quote threw (%s), falling back to OpenStreetMap/OSRM.",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // 2. Free Option 1: OpenStreetMap / OSRM routing + dynamic distance/time formula
  return await calculateFreeDeliveryQuote(
    destination,
    origin,
    config,
    fetchImpl,
  );
}
