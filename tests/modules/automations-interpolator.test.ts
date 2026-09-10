import { describe, expect, test } from "bun:test";
import {
  getNestedValue,
  interpolateFieldMapping,
  interpolateTemplate,
} from "@/modules/automations/interpolator";

describe("automations interpolator", () => {
  const context = {
    contact: {
      name: "Maria Silva",
      phone: "+5511999998888",
      tags: ["VIP", "Comprador"],
    },
    data: {
      orderId: "PED-12345",
      amount: 450.75,
      items: [
        { title: "Produto A", qty: 2 },
        { title: "Produto B", qty: 1 },
      ],
      active: true,
    },
  };

  test("getNestedValue extracts simple and deeply nested properties", () => {
    expect(getNestedValue(context, "contact.name")).toBe("Maria Silva");
    expect(getNestedValue(context, "data.amount")).toBe(450.75);
    expect(getNestedValue(context, "data.items[0].title")).toBe("Produto A");
    expect(getNestedValue(context, "data.items[1].qty")).toBe(1);
    expect(getNestedValue(context, "non.existent.path")).toBeUndefined();
    expect(getNestedValue(null, "foo")).toBeUndefined();
  });

  test("interpolateTemplate replaces placeholders correctly", () => {
    const tpl =
      "Olá {{contact.name}}, seu pedido {{data.orderId}} no valor de R$ {{data.amount}} foi confirmado!";
    const result = interpolateTemplate(tpl, context);
    expect(result).toBe(
      "Olá Maria Silva, seu pedido PED-12345 no valor de R$ 450.75 foi confirmado!",
    );
  });

  test("interpolateTemplate handles missing keys gracefully", () => {
    const tpl = "Cliente: {{contact.name}}, CPF: {{contact.cpf}}";
    const result = interpolateTemplate(tpl, context);
    expect(result).toBe("Cliente: Maria Silva, CPF: ");
  });

  test("interpolateFieldMapping preserves primitive types when mapping exact variable", () => {
    const mapping = {
      customer_name: "{{contact.name}}",
      customer_phone: "{{contact.phone}}",
      order_total: "{{data.amount}}",
      is_active: "{{data.active}}",
      greeting: "Bem-vindo, {{contact.name}}!",
    };

    const mapped = interpolateFieldMapping(mapping, context);
    expect(mapped.customer_name).toBe("Maria Silva");
    expect(mapped.customer_phone).toBe("+5511999998888");
    expect(mapped.order_total).toBe(450.75); // preserved as number!
    expect(mapped.is_active).toBe(true); // preserved as boolean!
    expect(mapped.greeting).toBe("Bem-vindo, Maria Silva!");
  });
});
