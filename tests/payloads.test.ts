import { describe, expect, it } from "vitest";
import {
  buildRefundBody,
  buildSaleAttempts,
  extractCodes,
  extractTid,
  goodsPaid,
  saleAmount,
  type OrderPayload,
  type SaleOptions,
} from "../app/lib/payloads";

const order: OrderPayload = {
  id: 13437378527577,
  name: "#1003",
  email: "buyer@example.com",
  currency: "PLN",
  subtotal_price: "10.00",
  note_attributes: [{ name: "fp_tid", value: "bf92936c-bbff-4c25-b257" }],
};

const link: SaleOptions = { trackCoupons: true, couponPriority: "link" };
const attempts = (o: OrderPayload, opts = link) => {
  const built = buildSaleAttempts(o, opts);
  return built.ok ? built.body : built;
};

describe("buildSaleAttempts", () => {
  it("maps a referred order like the working Flow setup", () => {
    expect(attempts(order)).toEqual([
      {
        uid: "#1003",
        event_id: "13437378527577",
        email: "buyer@example.com",
        amount: 1000,
        currency: "PLN",
        tid: "bf92936c-bbff-4c25-b257",
      },
    ]);
  });
  it("falls back to the numeric id when the order has no name", () => {
    expect(attempts({ ...order, name: undefined })).toMatchObject([
      { uid: "13437378527577" },
    ]);
  });
  it("skips orders with neither affiliate link nor code", () => {
    const plain = { ...order, note_attributes: [] };
    expect(attempts(plain)).toEqual({ ok: false, reason: "no_link_or_code" });
  });
  it("treats an empty fp_tid as missing", () => {
    const empty = { ...order, note_attributes: [{ name: "fp_tid", value: " " }] };
    expect(extractTid(empty)).toBeNull();
  });
  it("reads the tid from a line item property (Buy it now skips the cart)", () => {
    const buyNow: OrderPayload = {
      ...order,
      note_attributes: [],
      line_items: [{ properties: [{ name: "_fp_tid", value: "tid-from-item" }] }],
    };
    expect(extractTid(buyNow)).toBe("tid-from-item");
    expect(attempts(buyNow)).toEqual([expect.objectContaining({ tid: "tid-from-item" })]);
  });
  it("prefers the cart attribute over a line item property", () => {
    const both: OrderPayload = {
      ...order,
      line_items: [{ properties: [{ name: "_fp_tid", value: "other" }] }],
    };
    expect(extractTid(both)).toBe("bf92936c-bbff-4c25-b257");
  });
  it("skips zero and invalid amounts", () => {
    expect(attempts({ ...order, subtotal_price: "0.00" })).toEqual({ ok: false, reason: "zero_amount" });
    expect(attempts({ ...order, subtotal_price: null })).toEqual({ ok: false, reason: "invalid_amount" });
  });
  it("omits email when the order has none", () => {
    const result = attempts({ ...order, email: null }) as object[];
    expect("email" in result[0]).toBe(false);
  });
});

describe("coupon attribution", () => {
  const both: OrderPayload = { ...order, discount_codes: [{ code: "ANNA10" }] };
  it("tries the link first and the code as fallback by default", () => {
    const result = attempts(both) as Array<{ tid?: string; promo_code?: string }>;
    expect(result.map((a) => a.tid ?? a.promo_code)).toEqual([
      "bf92936c-bbff-4c25-b257",
      "ANNA10",
    ]);
  });
  it("tries the code first when configured, keeping the link as fallback", () => {
    const result = attempts(both, { ...link, couponPriority: "code" }) as Array<{
      tid?: string;
      promo_code?: string;
    }>;
    expect(result.map((a) => a.tid ?? a.promo_code)).toEqual([
      "ANNA10",
      "bf92936c-bbff-4c25-b257",
    ]);
  });
  it("tracks an order that only has a code", () => {
    const codeOnly = { ...order, note_attributes: [], discount_codes: [{ code: "ANNA10" }] };
    const result = attempts(codeOnly) as import("../app/lib/payloads").SaleBody[];
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ promo_code: "ANNA10", event_id: "13437378527577", uid: "#1003" });
  });
  it("ignores codes when coupon tracking is off", () => {
    const codeOnly = { ...order, note_attributes: [], discount_codes: [{ code: "ANNA10" }] };
    expect(attempts(codeOnly, { ...link, trackCoupons: false })).toEqual({
      ok: false,
      reason: "no_link_or_code",
    });
  });
  it("deduplicates codes and keeps at most two", () => {
    const many: OrderPayload = {
      ...order,
      discount_codes: [{ code: "a" }, { code: "A" }, { code: " " }, { code: "b" }, { code: "c" }],
    };
    expect(extractCodes(many)).toEqual(["a", "b"]);
  });
});

describe("buildRefundBody", () => {
  it("sums line item subtotals in shop currency and links the sale", () => {
    const built = buildRefundBody(
      {
        id: 555,
        order_id: 13437378527577,
        refund_line_items: [
          { subtotal_set: { shop_money: { amount: "4.00", currency_code: "PLN" } } },
          { subtotal_set: { shop_money: { amount: "1.50", currency_code: "PLN" } } },
        ],
      },
      "#1003",
    );
    expect(built).toEqual({
      ok: true,
      body: {
        uid: "#1003",
        event_id: "refund-555",
        sale_event_id: "13437378527577",
        amount: "550",
        currency: "PLN",
      },
    });
  });
  it("falls back to subtotal and omits currency when unknown", () => {
    const built = buildRefundBody({
      id: 1,
      order_id: 2,
      refund_line_items: [{ subtotal: 3 }],
    });
    expect(built.ok && built.body.amount).toBe("300");
    expect(built.ok && "currency" in built.body).toBe(false);
  });
  it("skips refunds that return no money (restock only)", () => {
    const restock = {
      id: 1,
      order_id: 2,
      refund_line_items: [{ subtotal: 540 }],
      transactions: [],
    };
    expect(buildRefundBody(restock)).toEqual({ ok: false, reason: "no_money_refunded" });
  });
  it("skips refunds of shipping only", () => {
    const shipping = {
      id: 1,
      order_id: 2,
      refund_line_items: [],
      refund_shipping_lines: [{ subtotal_amount_set: { shop_money: { amount: "15.00", currency_code: "USD" } } }],
      transactions: [{ kind: "refund", status: "success", amount: "15.00", currency: "USD" }],
    };
    expect(buildRefundBody(shipping)).toEqual({ ok: false, reason: "shipping_only" });
  });
  it("sends the money returned, not the line subtotal (restocking fee kept)", () => {
    const built = buildRefundBody({
      id: 1,
      order_id: 2,
      refund_line_items: [{ subtotal: 100 }],
      transactions: [{ kind: "refund", status: "success", amount: "90.00", currency: "USD" }],
    });
    expect(built.ok && built.body.amount).toBe("9000");
  });
  it("leaves out refunded shipping from a mixed refund", () => {
    const built = buildRefundBody({
      id: 1,
      order_id: 2,
      refund_line_items: [{ subtotal: 100 }],
      refund_shipping_lines: [{ amount_set: { shop_money: { amount: "15.00" } } }],
      transactions: [{ kind: "refund", status: "success", amount: "115.00", currency: "USD" }],
    });
    expect(built.ok && built.body.amount).toBe("10000");
  });
});

describe("refunds scaled to the sale", () => {
  const byAmount = (amount: string) => ({
    id: 3,
    order_id: 2,
    refund_line_items: [],
    transactions: [{ kind: "refund", status: "success", amount, currency: "PLN" }],
  });
  it("removes tax with the ratio of commission base to goods paid", () => {
    // Base 100.00 net, buyer paid 123.00 for the goods (VAT 23%).
    const built = buildRefundBody(byAmount("123.00"), "#1", { amount: 10000, goodsPaid: 12300, refunded: 0 });
    expect(built.ok && built.body.amount).toBe("10000");
  });
  it("never refunds more than the sale left", () => {
    const sale = { amount: 60000, goodsPaid: 60000, refunded: 0 };
    expect((buildRefundBody(byAmount("615.00"), "#1", sale) as { body: { amount: string } }).body.amount).toBe("60000");
    expect(buildRefundBody(byAmount("10.00"), "#1", { ...sale, refunded: 60000 })).toEqual({
      ok: false,
      reason: "nothing_left_to_refund",
    });
  });
});

describe("saleAmount and goodsPaid", () => {
  it("removes line taxes when prices include tax", () => {
    const vat: OrderPayload = {
      ...order,
      subtotal_price: "123.00",
      taxes_included: true,
      total_tax: "23.00",
      line_items: [{ tax_lines: [{ price_set: { shop_money: { amount: "23.00" } } }] }],
    };
    expect(saleAmount(vat)).toBe(10000);
    expect(attempts(vat)).toEqual([expect.objectContaining({ amount: 10000 })]);
  });
  it("falls back to total_tax when lines carry no tax", () => {
    expect(saleAmount({ ...order, subtotal_price: "123.00", taxes_included: true, total_tax: "23.00" })).toBe(10000);
  });
  it("keeps the subtotal when tax is added on top", () => {
    expect(saleAmount({ ...order, total_tax: "2.30" })).toBe(1000);
  });
  it("is the total without shipping", () => {
    const paid = goodsPaid({
      ...order,
      total_price: "138.00",
      total_shipping_price_set: { shop_money: { amount: "15.00" } },
    });
    expect(paid).toBe(12300);
  });
});

describe("refund of an amount without product lines", () => {
  it("uses the refund transactions", () => {
    const result = buildRefundBody(
      {
        id: 5,
        order_id: 7,
        refund_line_items: [],
        transactions: [
          { kind: "refund", status: "success", amount: "12.50", currency: "USD" },
          { kind: "sale", status: "success", amount: "99.00", currency: "USD" },
          { kind: "refund", status: "failure", amount: "5.00", currency: "USD" },
        ],
      },
      "#1100",
    );
    expect(result).toMatchObject({
      ok: true,
      body: { uid: "#1100", amount: "1250", currency: "USD", event_id: "refund-5", sale_event_id: "7" },
    });
  });
});
