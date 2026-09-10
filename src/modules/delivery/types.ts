export type DeliveryPricingMode =
  | "hybrid"
  | "free_osrm_only"
  | "uber_direct_only";

export interface DeliveryPricingConfig {
  originAddress?: string;
  originCoordinates?: { lat: number; lon: number };
  cityDefault?: string;
  pricingMode?: DeliveryPricingMode;
  baseFee?: number;
  pricePerKm?: number;
  pricePerMinute?: number;
  minimumFee?: number;
  uberCustomerId?: string;
}

export interface UberDirectCredentials {
  clientId: string;
  clientSecret: string;
  customerId?: string;
  isSandbox?: boolean;
}

export interface DeliveryQuoteInput {
  destinationAddress: string;
  originAddress?: string;
}

export interface DeliveryQuoteResult {
  success: boolean;
  provider: "UBER_DIRECT" | "OSRM_FREE";
  distanceKm: number;
  durationMinutes: number;
  priceBrl: number;
  formattedPrice: string;
  originAddress: string;
  destinationAddress: string;
  summaryMessage: string;
  quoteId?: string;
  rawDetails?: Record<string, unknown>;
}

export interface GeocodeLocation {
  lat: number;
  lon: number;
  displayName: string;
}

export interface RouteEstimate {
  distanceMeters: number;
  durationSeconds: number;
}
