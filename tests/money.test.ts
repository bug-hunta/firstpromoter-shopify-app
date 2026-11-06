import { describe, expect, it } from "vitest";
import { sumMoney, toMinorUnits } from "../app/lib/money";

describe("toMinorUnits", () => {
  it("converts to cents without float errors", () => {
    expect(toMinorUnits("10.00", "PLN")).toBe(1000);
    expect(toMinorUnits("19.99", "EUR")).toBe(1999);
    expect(toMinorUnits("0.29", "EUR")).toBe(29);
    expect(toMinorUnits("1.005", "EUR")).toBe(101);
    expect(toMinorUnits("5", "USD")).toBe(500);
  });
  it("sends zero-decimal currencies as whole values", () => {
    expect(toMinorUnits("1000", "JPY")).toBe(1000);
    expect(toMinorUnits("1000.00", "JPY")).toBe(1000);
  });
  it("rejects bad input", () => {
    expect(() => toMinorUnits("", "PLN")).toThrow();
    expect(() => toMinorUnits("-5.00", "PLN")).toThrow();
    expect(() => toMinorUnits("abc", "PLN")).toThrow();
  });
});

describe("sumMoney", () => {
  it("adds without drift", () => {
    expect(sumMoney(["0.10", "0.20"])).toBe("0.30");
    expect(sumMoney(["10.00", "5.55"])).toBe("15.55");
  });
});
