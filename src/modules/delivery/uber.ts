import logger from "@/api/lib/logger";
import { geocodeAddress } from "./osrm";
import type {
  DeliveryPricingConfig,
  DeliveryQuoteResult,
  UberDirectCredentials,
} from "./types";

const UBER_AUTH_URL = "https://login.uber.com/oauth/v2/token";
const UBER_DIRECT_ESTIMATES_URL =
  "https://api.uber.com/v1/eats/deliveries/estimates";
const REQUEST_TIMEOUT_MS = 10_000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

const TOKEN_CACHE = new Map<string, CachedToken>();

export async function getUberDirectToken(
  credentials: UberDirectCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!credentials.clientId || !credentials.clientSecret) {
    return null;
  }

  const cacheKey = `${credentials.clientId}:${credentials.isSandbox ? "sandbox" : "prod"}`;
  const cached = TOKEN_CACHE.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.token;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const body = new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: "client_credentials",
      scope: "eats.deliveries",
    });

    const res = await fetchImpl(UBER_AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      logger.warn(
        "Uber OAuth failed HTTP %d: %s",
        res.status,
        errText.slice(0, 200),
      );
      return null;
    }

    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      logger.warn("Uber OAuth returned no access_token");
      return null;
    }

    const expiresInSec = data.expires_in ?? 3600;
    TOKEN_CACHE.set(cacheKey, {
      token: data.access_token,
      expiresAt: Date.now() + expiresInSec * 1000,
    });

    return data.access_token;
  } catch (err) {
    logger.error(
      "Uber OAuth request error: %s",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function calculateUberDirectQuote(
  destinationAddress: string,
  originAddress: string,
  credentials: UberDirectCredentials,
  config: DeliveryPricingConfig = {},
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryQuoteResult | null> {
  const token = await getUberDirectToken(credentials, fetchImpl);
  if (!token) {
    return null;
  }

  const cityDefault = config.cityDefault || "Rio de Janeiro, RJ";
  const originLoc = config.originCoordinates
    ? {
        lat: config.originCoordinates.lat,
        lon: config.originCoordinates.lon,
        displayName: originAddress,
      }
    : await geocodeAddress(originAddress, cityDefault, fetchImpl);

  if (!originLoc) {
    logger.warn(
      "Uber Direct: could not resolve origin coordinates for %s",
      originAddress,
    );
    return null;
  }

  const destLoc = await geocodeAddress(
    destinationAddress,
    cityDefault,
    fetchImpl,
  );
  if (!destLoc) {
    logger.warn(
      "Uber Direct: could not resolve destination coordinates for %s",
      destinationAddress,
    );
    return null;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const payload = {
      pickup_address: JSON.stringify({
        street_address: [originLoc.displayName],
        city: "Rio de Janeiro",
        state: "RJ",
        country: "BR",
      }),
      dropoff_address: JSON.stringify({
        street_address: [destLoc.displayName],
        city: "Rio de Janeiro",
        state: "RJ",
        country: "BR",
      }),
      pickup_latitude: originLoc.lat,
      pickup_longitude: originLoc.lon,
      dropoff_latitude: destLoc.lat,
      dropoff_longitude: destLoc.lon,
      ...(credentials.customerId
        ? { customer_id: credentials.customerId }
        : {}),
    };

    const res = await fetchImpl(UBER_DIRECT_ESTIMATES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      logger.warn(
        "Uber Direct estimate failed HTTP %d: %s",
        res.status,
        errText.slice(0, 300),
      );
      return null;
    }

    const data = (await res.json()) as {
      fee?: number; // fee in cents
      currency?: string;
      duration?: number; // duration in minutes
      quote_id?: string;
      dropoff_eta?: string;
      distance?: number;
    };

    if (data.fee == null) {
      logger.warn("Uber Direct estimate returned no fee");
      return null;
    }

    const priceBrl = Math.round(data.fee) / 100;
    const durationMinutes = data.duration ?? 20;
    const distanceKm = data.distance
      ? Math.round((data.distance / 1000) * 10) / 10
      : 0;

    const formattedPrice = new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(priceBrl);

    const summaryMessage =
      `Cotação oficial Uber Direct:\n` +
      `- Valor da entrega: ${formattedPrice}\n` +
      `- Tempo estimado de entrega: cerca de ${durationMinutes} minutos\n` +
      `- Origem: ${originLoc.displayName}\n` +
      `- Destino: ${destLoc.displayName}\n` +
      `- Código da cotação: ${data.quote_id || "N/A"}`;

    return {
      success: true,
      provider: "UBER_DIRECT",
      distanceKm,
      durationMinutes,
      priceBrl,
      formattedPrice,
      originAddress: originLoc.displayName,
      destinationAddress: destLoc.displayName,
      summaryMessage,
      quoteId: data.quote_id,
      rawDetails: data,
    };
  } catch (err) {
    logger.error(
      "Uber Direct estimate call threw: %s",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
