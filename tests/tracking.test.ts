import { beforeAll, describe, expect, it, vi } from "vitest";
import { encrypt } from "../app/lib/crypto.server";
import {
  processPaidOrder,
  processRefund,
  type EventLogEntry,
  type StoredSettings,
} from "../app/lib/tracking.server";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

const order = {
  id: 42,
  email: "a@b.pl",
  currency: "PLN",
  subtotal_price: "10.00",
  note_attributes: [{ name: "fp_tid", value: "tid-1" }],
};

function setup(overrides: Partial<StoredSettings> = {}, outcome: object = { outcome: "tracked", status: 200 }) {
  const logs: EventLogEntry[] = [];
  const track = vi.fn().mockResolvedValue(outcome);
  const settings: StoredSettings = {
    accountId: "acc1",
    apiKeyEnc: encrypt("my-api-key"),
    trackCoupons: true,
    couponPriority: "link",
    trackSales: true,
    trackRefunds: true,
    ...overrides,
  };
  return {
    logs,
    track,
    deps: {
      getSettings: vi.fn().mockResolvedValue(settings),
      logEvent: async (e: EventLogEntry) => void logs.push(e),
      track: track as never,
    },
  };
}

describe("processPaidOrder", () => {
  it("decrypts the key, calls FirstPromoter and logs the result", async () => {
    const { deps, logs, track } = setup();
    const result = await processPaidOrder("shop.myshopify.com", order, deps);
    expect(result.retry).toBe(false);
    expect(track).toHaveBeenCalledWith(
      "sale",
      { accountId: "acc1", apiKey: "my-api-key" },
      expect.objectContaining({ uid: "42", tid: "tid-1", amount: 1000 }),
      expect.anything(),
    );
    expect(logs[0]).toMatchObject({ status: "tracked", httpStatus: 200, type: "sale" });
  });
  it("does not call FirstPromoter for orders without a referral", async () => {
    const { deps, logs, track } = setup();
    await processPaidOrder("s", { ...order, note_attributes: [] }, deps);
    expect(track).not.toHaveBeenCalled();
    expect(logs[0]).toMatchObject({ status: "skipped", message: "no_link_or_code" });
  });
  it("skips when the shop is not configured", async () => {
    const { deps, logs, track } = setup();
    deps.getSettings.mockResolvedValue(null);
    await processPaidOrder("s", order, deps);
    expect(track).not.toHaveBeenCalled();
    expect(logs[0].message).toBe("not_configured");
  });
  it("asks Shopify to redeliver when FirstPromoter is down", async () => {
    const { deps, logs } = setup({}, { outcome: "retry", status: 502 });
    expect((await processPaidOrder("s", order, deps)).retry).toBe(true);
    expect(logs[0].status).toBe("retrying");
  });
  it("does not retry client errors but records them", async () => {
    const { deps, logs } = setup({}, { outcome: "error", status: 401, message: "bad key" });
    expect((await processPaidOrder("s", order, deps)).retry).toBe(false);
    expect(logs[0]).toMatchObject({ status: "error", httpStatus: 401 });
  });
  it("logs unreadable credentials instead of throwing", async () => {
    const { deps, logs } = setup({ apiKeyEnc: "garbage" });
    expect((await processPaidOrder("s", order, deps)).retry).toBe(false);
    expect(logs[0].message).toBe("credentials_unreadable");
  });
  it("respects the trackSales switch", async () => {
    const { deps, track } = setup({ trackSales: false });
    await processPaidOrder("s", order, deps);
    expect(track).not.toHaveBeenCalled();
  });
});

describe("processPaidOrder with coupon codes", () => {
  const withCode = { ...order, discount_codes: [{ code: "ANNA10" }] };
  const codeOnly = { ...withCode, note_attributes: [] };
  it("sends the code with the order number as uid", async () => {
    const { deps, logs, track } = setup();
    await processPaidOrder("s", codeOnly, deps);
    expect(track).toHaveBeenCalledTimes(1);
    const [kind, , body] = track.mock.calls[0];
    expect(kind).toBe("sale");
    expect(body).toMatchObject({ uid: "42", email: "a@b.pl", promo_code: "ANNA10", event_id: "42", amount: 1000 });
    expect(body.ref_id).toBeUndefined();
    expect(logs[0]).toMatchObject({ status: "tracked", message: "via code ANNA10" });
  });
  it("falls back to the code when the link is not an affiliate's", async () => {
    const { deps, logs, track } = setup();
    track
      .mockResolvedValueOnce({ outcome: "no_referral", status: 404 })
      .mockResolvedValueOnce({ outcome: "tracked", status: 200 });
    await processPaidOrder("s", withCode, deps);
    expect(track.mock.calls[0][2]).toMatchObject({ tid: "tid-1" });
    expect(track.mock.calls[1][2]).toMatchObject({ promo_code: "ANNA10" });
    expect(logs[0]).toMatchObject({
      status: "tracked",
      message: "via code ANNA10 (link is not a referral)",
    });
  });
  it("stops after the first signal that FirstPromoter accepts", async () => {
    const { deps, logs, track } = setup();
    await processPaidOrder("s", withCode, deps);
    expect(track).toHaveBeenCalledTimes(1);
    expect(logs[0]).toMatchObject({ status: "tracked", message: "via link" });
  });
  it("tries the code first when the priority says so", async () => {
    const { deps, track } = setup({ couponPriority: "code" });
    await processPaidOrder("s", withCode, deps);
    expect(track.mock.calls[0][2]).toMatchObject({ promo_code: "ANNA10" });
  });
  it("shows both attempts when the code fails and the link works", async () => {
    const { deps, logs, track } = setup({ couponPriority: "code" });
    track
      .mockResolvedValueOnce({ outcome: "no_referral", status: 404 })
      .mockResolvedValueOnce({ outcome: "tracked", status: 200 });
    await processPaidOrder("s", withCode, deps);
    expect(logs[0]).toMatchObject({
      status: "tracked",
      message: "via link (code ANNA10 is not a referral)",
    });
  });
  it("reports no referral only after every signal was rejected", async () => {
    const { deps, logs, track } = setup({}, { outcome: "no_referral", status: 404 });
    await processPaidOrder("s", withCode, deps);
    expect(track).toHaveBeenCalledTimes(2);
    expect(logs[0]).toMatchObject({
      status: "no_referral",
      message: "link is not a referral; code ANNA10 is not a referral",
    });
  });
});

const tx = (amount: string) => [{ kind: "refund", status: "success", amount, currency: "PLN" }];

describe("processRefund of a sale that was not tracked", () => {
  const refund = { id: 9, order_id: 42, refund_line_items: [], transactions: tx("4.00") };
  it.each(["skipped", "no_referral"] as const)("skips the refund when the sale was %s", async (status) => {
    const { deps, logs, track } = setup();
    const result = await processRefund("s", refund, {
      ...deps,
      getSaleRecord: async () => ({ status, message: null }),
    });
    expect(result.retry).toBe(false);
    expect(track).not.toHaveBeenCalled();
    expect(logs[0]).toMatchObject({ type: "refund", status: "skipped", message: "sale_not_tracked" });
  });
});

describe("processRefund", () => {
  const refund = {
    id: 9,
    order_id: 42,
    refund_line_items: [{ subtotal_set: { shop_money: { amount: "4.00", currency_code: "PLN" } } }],
  };
  it("sends a refund linked to the original sale", async () => {
    const { deps, logs, track } = setup();
    await processRefund("s", refund, deps);
    expect(track).toHaveBeenCalledWith(
      "refund",
      expect.anything(),
      { uid: "42", event_id: "refund-9", sale_event_id: "42", amount: "400", currency: "PLN" },
    );
    expect(logs[0]).toMatchObject({ type: "refund", eventId: "refund-9" });
  });
  it("uses the order number looked up for the order as uid", async () => {
    const { deps, track } = setup();
    const getOrderName = vi.fn().mockResolvedValue("#1003");
    await processRefund("s", refund, { ...deps, getOrderName });
    expect(getOrderName).toHaveBeenCalledWith("s", "42");
    expect(track).toHaveBeenCalledWith(
      "refund",
      expect.anything(),
      expect.objectContaining({ uid: "#1003", sale_event_id: "42" }),
    );
  });
  it("asks Shopify to redeliver when the order lookup fails", async () => {
    const { deps, track, logs } = setup();
    const getOrderName = vi.fn().mockRejectedValue(new Error("boom"));
    const result = await processRefund("s", refund, { ...deps, getOrderName });
    expect(result.retry).toBe(true);
    expect(track).not.toHaveBeenCalled();
    expect(logs[0]).toMatchObject({
      status: "retrying",
      message: "order_lookup_failed: boom",
    });
  });
  it("respects the trackRefunds switch", async () => {
    const { deps, track } = setup({ trackRefunds: false });
    await processRefund("s", refund, deps);
    expect(track).not.toHaveBeenCalled();
  });
});

describe("one delivery reaches FirstPromoter", () => {
  it("does not send a sale another delivery already handled", async () => {
    const { deps, logs, track } = setup();
    const claim = vi.fn().mockResolvedValue(false);
    expect((await processPaidOrder("s", order, { ...deps, claim })).retry).toBe(false);
    expect(claim).toHaveBeenCalledWith("s", "sale", "42", "42");
    expect(track).not.toHaveBeenCalled();
    expect(logs).toHaveLength(0);
  });
  it("asks for a redelivery when the reservation cannot be made", async () => {
    const { deps, track } = setup();
    const claim = vi.fn().mockRejectedValue(new Error("db down"));
    expect((await processPaidOrder("s", order, { ...deps, claim })).retry).toBe(true);
    expect(track).not.toHaveBeenCalled();
  });
  it("logs the amounts sent with the sale", async () => {
    const { deps, logs } = setup();
    await processPaidOrder("s", { ...order, total_price: "12.30" }, { ...deps, claim: async () => true });
    expect(logs[0]).toMatchObject({ status: "tracked", amount: 1000, goodsPaid: 1230 });
  });
});

describe("processRefund against the recorded sale", () => {
  const refund = { id: 9, order_id: 42, refund_line_items: [], transactions: tx("12.30") };
  const tracked = { status: "tracked" as const, amount: 1000, goodsPaid: 1230 };
  it("waits for the sale when the refund comes first", async () => {
    const { deps, logs, track } = setup();
    const result = await processRefund("s", refund, { ...deps, getSaleRecord: async () => null });
    expect(result.retry).toBe(true);
    expect(track).not.toHaveBeenCalled();
    expect(logs[0]).toMatchObject({ status: "retrying", message: "waiting_for_sale" });
  });
  it("scales the refund to the commission base", async () => {
    const { deps, logs, track } = setup();
    await processRefund("s", refund, { ...deps, getSaleRecord: async () => tracked, getRefundedAmount: async () => 0 });
    expect(track.mock.calls[0][2]).toMatchObject({ amount: "1000" });
    expect(logs[0]).toMatchObject({ status: "tracked", amount: 1000 });
  });
  it("skips a refund when earlier refunds used up the sale", async () => {
    const { deps, logs, track } = setup();
    await processRefund("s", refund, { ...deps, getSaleRecord: async () => tracked, getRefundedAmount: async () => 1000 });
    expect(track).not.toHaveBeenCalled();
    expect(logs[0]).toMatchObject({ status: "skipped", message: "nothing_left_to_refund" });
  });
  it("skips restock-only refunds without asking FirstPromoter", async () => {
    const { deps, logs, track } = setup();
    const restock = { id: 9, order_id: 42, refund_line_items: [{ subtotal: 5 }], transactions: [] };
    await processRefund("s", restock, { ...deps, getSaleRecord: async () => tracked });
    expect(track).not.toHaveBeenCalled();
    expect(logs[0]).toMatchObject({ status: "skipped", message: "no_money_refunded" });
  });
});
