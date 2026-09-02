import { describe, expect, test } from "bun:test";
import { hasActivePriorHistory } from "@/modules/whazing/intake";

describe("hasActivePriorHistory", () => {
  test("false when the only ticket for this phone is the current one", () => {
    expect(hasActivePriorHistory(2, [{ id: 2, status: "pending" }])).toBe(
      false,
    );
  });

  test("false when every OTHER ticket for this phone is closed", () => {
    expect(
      hasActivePriorHistory(3, [
        { id: 1, status: "closed" },
        { id: 2, status: "closed" },
        { id: 3, status: "pending" },
      ]),
    ).toBe(false);
  });

  test("true when another ticket for this phone is still open/pending", () => {
    expect(
      hasActivePriorHistory(3, [
        { id: 1, status: "closed" },
        { id: 2, status: "pending" },
        { id: 3, status: "pending" },
      ]),
    ).toBe(true);
  });

  test("true when another ticket is open (not just pending)", () => {
    expect(
      hasActivePriorHistory(2, [
        { id: 1, status: "open" },
        { id: 2, status: "pending" },
      ]),
    ).toBe(true);
  });
});
