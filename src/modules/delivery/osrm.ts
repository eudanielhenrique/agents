import logger from "@/api/lib/logger";
import type {
  DeliveryPricingConfig,
  DeliveryQuoteResult,
  GeocodeLocation,
  RouteEstimate,
} from "./types";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/search";
const OSRM_ROUTER_BASE = "https://router.project-osrm.org/route/v1/driving";
const USER_AGENT = "AgentsPlatform/1.0 (delivery-calculator; support@fazer.ai)";
const REQUEST_TIMEOUT_MS = 8_000;

// In-memory cache for geocoding to respect OSM rate limits and speed up repeat queries
const GEOCODE_CACHE = new Map<
  string,
  { loc: GeocodeLocation; timestamp: number }
>();
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours
const MAX_CACHE_ENTRIES = 500;

export async function geocodeAddress(
  address: string,
  cityDefault?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GeocodeLocation | null> {
  let cleaned = address.trim();
  if (!cleaned) return null;

  // If no city/state suffix found and default provided, enrich query
  if (
    cityDefault &&
    !cleaned.toLowerCase().includes("rio de janeiro") &&
    !cleaned.toLowerCase().includes(", rj")
  ) {
    cleaned = `${cleaned}, ${cityDefault}`;
  }

  const cacheKey = cleaned.toLowerCase();
  const cached = GEOCODE_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.loc;
  }

  const url = `${NOMINATIM_BASE}?format=json&limit=1&q=${encodeURIComponent(cleaned)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetchImpl(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });

    if (!res.ok) {
      logger.warn(
        "OSM Nominatim geocode returned HTTP %d for %s",
        res.status,
        cleaned,
      );
      return null;
    }

    const data = (await res.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
    }>;
    const first = data[0];
    if (!first?.lat || !first?.lon) {
      logger.warn("OSM Nominatim found no coordinates for %s", cleaned);
      return null;
    }

    const loc: GeocodeLocation = {
      lat: parseFloat(first.lat),
      lon: parseFloat(first.lon),
      displayName: first.display_name,
    };

    // Trim cache if too large
    if (GEOCODE_CACHE.size >= MAX_CACHE_ENTRIES) {
      const firstKey = GEOCODE_CACHE.keys().next().value;
      if (firstKey) GEOCODE_CACHE.delete(firstKey);
    }
    GEOCODE_CACHE.set(cacheKey, { loc, timestamp: Date.now() });

    return loc;
  } catch (err) {
    logger.error(
      "OSM Nominatim geocode failed for %s: %s",
      cleaned,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function calculateOsrmRoute(
  origin: GeocodeLocation,
  dest: GeocodeLocation,
  fetchImpl: typeof fetch = fetch,
): Promise<RouteEstimate | null> {
  const url = `${OSRM_ROUTER_BASE}/${origin.lon},${origin.lat};${dest.lon},${dest.lat}?overview=false`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetchImpl(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });

    if (!res.ok) {
      logger.warn("OSRM routing returned HTTP %d", res.status);
      return null;
    }

    const data = (await res.json()) as {
      code?: string;
      routes?: Array<{ distance: number; duration: number }>;
    };

    const firstRoute = data.routes?.[0];
    if (data.code !== "Ok" || !firstRoute) {
      logger.warn("OSRM routing returned no valid route");
      return null;
    }

    return {
      distanceMeters: firstRoute.distance,
      durationSeconds: firstRoute.duration,
    };
  } catch (err) {
    logger.error(
      "OSRM routing failed: %s",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function calculateFreeDeliveryQuote(
  destinationAddress: string,
  originAddress: string,
  config: DeliveryPricingConfig = {},
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryQuoteResult> {
  const cityDefault = config.cityDefault || "Rio de Janeiro, RJ";
  const originLoc = config.originCoordinates
    ? {
        lat: config.originCoordinates.lat,
        lon: config.originCoordinates.lon,
        displayName: originAddress,
      }
    : await geocodeAddress(originAddress, cityDefault, fetchImpl);

  if (!originLoc) {
    throw new Error(
      `Não foi possível localizar o endereço de origem: "${originAddress}"`,
    );
  }

  const destLoc = await geocodeAddress(
    destinationAddress,
    cityDefault,
    fetchImpl,
  );
  if (!destLoc) {
    throw new Error(
      `Não foi possível localizar o endereço de destino: "${destinationAddress}". Verifique se o nome da rua ou bairro está correto.`,
    );
  }

  const route = await calculateOsrmRoute(originLoc, destLoc, fetchImpl);
  if (!route) {
    throw new Error(
      "Não foi possível traçar uma rota rodoviária entre a origem e o destino.",
    );
  }

  const distanceKm = Math.round((route.distanceMeters / 1000) * 10) / 10;
  const durationMinutes = Math.max(1, Math.round(route.durationSeconds / 60));

  const baseFee = config.baseFee ?? 8.0;
  const pricePerKm = config.pricePerKm ?? 2.5;
  const pricePerMinute = config.pricePerMinute ?? 0.35;
  const minimumFee = config.minimumFee ?? 12.0;

  const rawFee =
    baseFee + distanceKm * pricePerKm + durationMinutes * pricePerMinute;
  const priceBrl = Math.max(minimumFee, Math.round(rawFee * 100) / 100);

  const formattedPrice = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(priceBrl);

  const summaryMessage =
    `Cotação de entrega (OpenStreetMap/OSRM):\n` +
    `- Distância: ${distanceKm} km\n` +
    `- Tempo estimado de rota: cerca de ${durationMinutes} minutos\n` +
    `- Valor estimado: ${formattedPrice}`;

  return {
    success: true,
    provider: "OSRM_FREE",
    distanceKm,
    durationMinutes,
    priceBrl,
    formattedPrice,
    originAddress: originLoc.displayName,
    destinationAddress: destLoc.displayName,
    summaryMessage,
    rawDetails: {
      routeDistanceMeters: route.distanceMeters,
      routeDurationSeconds: route.durationSeconds,
      baseFee,
      pricePerKm,
      pricePerMinute,
      minimumFee,
    },
  };
}
