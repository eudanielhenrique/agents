import { describe, expect, it } from "bun:test";
import { executeAction } from "@/modules/automations/runner";
import type {
  AutomationActionConfig,
  NormalizedChannelEvent,
} from "@/modules/automations/types";
import {
  calculateDeliveryQuote,
  calculateFreeDeliveryQuote,
} from "@/modules/delivery";
import { DeliveryToolpack } from "@/modules/integrations/toolpacks/delivery";
import type { ToolpackCtx } from "@/modules/integrations/toolpacks/types";

describe("delivery module - OSRM and geocoding", () => {
  it("geocodes and calculates delivery freight with custom formula", async () => {
    // Custom mock fetch to simulate Nominatim and OSRM deterministically
    const mockFetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("nominatim.openstreetmap.org")) {
        if (urlStr.includes("Italianos")) {
          return new Response(
            JSON.stringify([
              {
                lat: "-22.8313",
                lon: "-43.3454",
                display_name:
                  "Av. dos Italianos, 1406, Rocha Miranda, Rio de Janeiro",
              },
            ]),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify([
            {
              lat: "-22.8702",
              lon: "-43.3410",
              display_name: "Madureira Shopping, Rio de Janeiro",
            },
          ]),
          { status: 200 },
        );
      }
      if (urlStr.includes("router.project-osrm.org")) {
        return new Response(
          JSON.stringify({
            code: "Ok",
            routes: [
              {
                distance: 5000, // 5.0 km
                duration: 600, // 10 minutes
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const quote = await calculateFreeDeliveryQuote(
      "Madureira Shopping",
      "Av. dos Italianos, 1406",
      {
        baseFee: 10.0,
        pricePerKm: 2.0,
        pricePerMinute: 0.5,
        minimumFee: 15.0,
      },
      mockFetch,
    );

    expect(quote.success).toBe(true);
    expect(quote.provider).toBe("OSRM_FREE");
    expect(quote.distanceKm).toBe(5);
    expect(quote.durationMinutes).toBe(10);
    // base (10) + km (5 * 2 = 10) + time (10 * 0.5 = 5) = 25.00
    expect(quote.priceBrl).toBe(25.0);
    expect(quote.formattedPrice).toContain("25,00");
  });

  it("applies minimum fee when calculated freight is below minimum", async () => {
    const mockFetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("nominatim.openstreetmap.org")) {
        return new Response(
          JSON.stringify([
            {
              lat: "-22.8310",
              lon: "-43.3450",
              display_name: "Rua Vizinha, 10, Rocha Miranda",
            },
          ]),
          { status: 200 },
        );
      }
      if (urlStr.includes("router.project-osrm.org")) {
        return new Response(
          JSON.stringify({
            code: "Ok",
            routes: [{ distance: 500, duration: 60 }], // 0.5 km, 1 min
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const quote = await calculateFreeDeliveryQuote(
      "Rua Vizinha, 10",
      "Av. dos Italianos, 1406",
      {
        baseFee: 5.0,
        pricePerKm: 2.0,
        pricePerMinute: 0.2,
        minimumFee: 15.0, // Minimum fee higher than calculated (5 + 1 + 0.2 = 6.2)
      },
      mockFetch,
    );

    expect(quote.priceBrl).toBe(15.0);
    expect(quote.formattedPrice).toContain("15,00");
  });
});

describe("delivery service - hybrid strategy and Uber Direct fallback", () => {
  it("falls back to OSRM Free when Uber Direct credentials fail or are invalid", async () => {
    const mockFetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("login.uber.com")) {
        return new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 401,
        });
      }
      if (urlStr.includes("nominatim.openstreetmap.org")) {
        return new Response(
          JSON.stringify([
            {
              lat: "-22.8313",
              lon: "-43.3454",
              display_name: "Av. dos Italianos, 1406",
            },
          ]),
          { status: 200 },
        );
      }
      if (urlStr.includes("router.project-osrm.org")) {
        return new Response(
          JSON.stringify({
            code: "Ok",
            routes: [{ distance: 3000, duration: 300 }],
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const result = await calculateDeliveryQuote(
      { destinationAddress: "Madureira, RJ" },
      { pricingMode: "hybrid", baseFee: 8.0, pricePerKm: 2.5 },
      { clientId: "bad_client", clientSecret: "bad_secret" },
      mockFetch,
    );

    expect(result.success).toBe(true);
    expect(result.provider).toBe("OSRM_FREE");
  });

  it("uses Uber Direct when API succeeds", async () => {
    const mockFetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("login.uber.com")) {
        return new Response(
          JSON.stringify({
            access_token: "mock_uber_token_123",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      if (urlStr.includes("nominatim.openstreetmap.org")) {
        return new Response(
          JSON.stringify([
            {
              lat: "-22.8313",
              lon: "-43.3454",
              display_name: "Av. dos Italianos, 1406",
            },
          ]),
          { status: 200 },
        );
      }
      if (urlStr.includes("api.uber.com/v1/eats/deliveries/estimates")) {
        return new Response(
          JSON.stringify({
            fee: 1950, // R$ 19,50
            duration: 18,
            quote_id: "dqt_mock_quote_999",
            distance: 4200,
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const result = await calculateDeliveryQuote(
      { destinationAddress: "Madureira, RJ" },
      { pricingMode: "hybrid" },
      { clientId: "valid_id", clientSecret: "valid_secret" },
      mockFetch,
    );

    expect(result.success).toBe(true);
    expect(result.provider).toBe("UBER_DIRECT");
    expect(result.priceBrl).toBe(19.5);
    expect(result.quoteId).toBe("dqt_mock_quote_999");
    expect(result.durationMinutes).toBe(18);
    expect(result.formattedPrice).toContain("19,50");
  });
});

describe("DeliveryToolpack", () => {
  it("builds the calcular_frete_entrega tool with proper schema", () => {
    const tools = DeliveryToolpack.build(
      {
        instanceId: 1n,
        catalogType: "DELIVERY",
        config: { originAddress: "Av. dos Italianos, 1406" },
        credentialRef: null,
        enabledTools: ["calcular_frete_entrega"],
      },
      {
        tenantId: 1n,
        base: {} as unknown as ToolpackCtx["base"],
        threadId: "test_thread",
        resolveCredential: async () => null,
      },
    );

    expect(tools.length).toBe(1);
    expect(tools[0]?.name).toBe("calcular_frete_entrega");
  });
});

describe("automation action DELIVERY:calculate_quote", () => {
  it("executes delivery action through the automation runner", async () => {
    const actionConfig: AutomationActionConfig = {
      id: "action_deliv_1",
      order: 1,
      provider: "DELIVERY",
      actionType: "calculate_quote",
      fieldMapping: {
        destination: "{{contact.customAttributes.bairro}}",
      },
      settings: {
        baseFee: 10,
        pricePerKm: 2,
        minimumFee: 15,
      },
    };

    const event: NormalizedChannelEvent = {
      eventId: "evt_1",
      tenantId: 1n,
      channelType: "WHAZING",
      channelInstanceId: "inst_1",
      triggerType: "channel.lead_created",
      occurredAt: new Date(),
      contact: {
        name: "Carlos",
        phone: "5521999998888",
        customAttributes: {
          bairro: "Madureira, Rio de Janeiro",
        },
      },
      data: {},
    };

    const stepResult = await executeAction(actionConfig, event);
    expect(stepResult.status).toBe("SUCCESS");
    expect(stepResult.output).toBeDefined();
    expect(stepResult.output?.priceBrl).toBeGreaterThanOrEqual(15);
    expect(stepResult.output?.provider).toBe("OSRM_FREE");
  });
});
