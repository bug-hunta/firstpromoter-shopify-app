import { decrypt } from "./crypto.server";
import {
  track,
  type CallResult,
  type Credentials,
} from "./firstpromoter.server";
import {
  buildRefundBody,
  buildSaleAttempts,
  goodsPaid,
  refundedGoods,
  type CouponPriority,
  type OrderPayload,
  type RefundPayload,
  type SaleAmounts,
  type SaleBody,
} from "./payloads";

export type EventType = "sale" | "refund";

export type EventStatus =
  | "tracked"
  | "no_referral"
  | "duplicate"
  | "skipped"
  | "error"
  | "retrying"
  | "processing";

export interface StoredSettings {
  accountId: string;
  apiKeyEnc: string;
  trackCoupons: boolean;
  couponPriority: string;
  trackSales: boolean;
  trackRefunds: boolean;
}

export interface EventLogEntry {
  shop: string;
  type: EventType;
  eventId: string;
  orderId: string;
  status: EventStatus;
  httpStatus?: number;
  message?: string;
  /** Minor units sent to FirstPromoter (sale base or refund amount). */
  amount?: number;
  /** Sales only: what the buyer paid for the goods, in minor units. */
  goodsPaid?: number;
}

export interface SaleRecord {
  status: EventStatus;
  message?: string | null;
  amount?: number | null;
  goodsPaid?: number | null;
}

/** Everything the tracking logic needs from the outside world. */
export interface TrackingDeps {
  getSettings(shop: string): Promise<StoredSettings | null>;
  logEvent(entry: EventLogEntry): Promise<void>;
  track?: typeof track;
  /**
   * Reserves an event before it is sent, so parallel or repeated deliveries
   * of the same webhook reach FirstPromoter once. False: already handled.
   */
  claim?(shop: string, type: EventType, eventId: string, orderId: string): Promise<boolean>;
  /** Log record for the sale of an order, null if there is no record. */
  getSaleRecord?(shop: string, orderId: string): Promise<SaleRecord | null>;
  /** Sum of the refund amounts already sent for an order (minor units). */
  getRefundedAmount?(shop: string, orderId: string): Promise<number>;
  /** Order number ("#1003") for a numeric order id; null if unknown. */
  getOrderName?(shop: string, orderId: string): Promise<string | null>;
}

/** retry=true makes the webhook route answer 5xx so Shopify redelivers. */
export interface ProcessResult {
  retry: boolean;
}

const DONE: ProcessResult = { retry: false };
const SALE_BUDGET_MS = 4000;

function toStatus(result: CallResult): EventStatus {
  switch (result.outcome) {
    case "tracked":
      return "tracked";
    case "no_referral":
      return "no_referral";
    case "duplicate":
      return "duplicate";
    case "retry":
      return "retrying";
    default:
      return "error";
  }
}

function credentialsFrom(settings: StoredSettings): Credentials | null {
  try {
    return { accountId: settings.accountId, apiKey: decrypt(settings.apiKeyEnc) };
  } catch {
    return null;
  }
}

export async function processPaidOrder(
  shop: string,
  order: OrderPayload,
  deps: TrackingDeps,
): Promise<ProcessResult> {
  const orderId = String(order.id);
  const base = { shop, type: "sale" as const, eventId: orderId, orderId };

  const settings = await deps.getSettings(shop);
  if (!settings || !settings.trackSales) {
    await deps.logEvent({ ...base, status: "skipped", message: "not_configured" });
    return DONE;
  }

  const built = buildSaleAttempts(order, {
    trackCoupons: settings.trackCoupons,
    couponPriority: (settings.couponPriority === "code" ? "code" : "link") as CouponPriority,
  });
  if (!built.ok) {
    await deps.logEvent({ ...base, status: "skipped", message: built.reason });
    return DONE;
  }

  const creds = credentialsFrom(settings);
  if (!creds) {
    await deps.logEvent({ ...base, status: "error", message: "credentials_unreadable" });
    return DONE;
  }

  if (deps.claim) {
    try {
      if (!(await deps.claim(shop, "sale", orderId, orderId))) return DONE;
    } catch {
      // Without the reservation a parallel delivery could double the commission.
      return { retry: true };
    }
  }
  const amounts = { amount: built.body[0].amount, goodsPaid: goodsPaid(order) ?? undefined };

  // Shopify expects an answer within 5 seconds, so all attempts share one budget.
  const startedAt = Date.now();
  const left = () => SALE_BUDGET_MS - (Date.now() - startedAt);
  const trail: string[] = [];
  let result: CallResult | undefined;
  let via = "";
  for (const attempt of built.body) {
    if (left() < 300) {
      await deps.logEvent({ ...base, ...amounts, status: "retrying", message: "time_budget_exceeded" });
      return { retry: true };
    }
    const body: SaleBody = attempt;
    let label = "link";
    if (attempt.promo_code) {
      // FirstPromoter decides whether the code belongs to an affiliate and creates the lead.
      label = `code ${attempt.promo_code}`;
    }
    result = await (deps.track ?? track)("sale", creds, body, { timeoutMs: left() });
    via = label;
    // 404 = this signal is not an affiliate's; the next one may still be.
    if (result.outcome !== "no_referral") break;
    trail.push(`${label} is not a referral`);
  }

  const notes = trail.length ? ` (${trail.join("; ")})` : "";
  if (!result || result.outcome === "no_referral") {
    await deps.logEvent({
      ...base,
      ...amounts,
      status: "no_referral",
      httpStatus: result?.status,
      message: trail.join("; ").slice(0, 200),
    });
    return DONE;
  }
  await deps.logEvent({
    ...base,
    ...amounts,
    status: toStatus(result),
    httpStatus: result.status,
    message:
      result.outcome === "tracked" ? `via ${via}${notes}`.slice(0, 200) : result.message,
  });
  return { retry: result.outcome === "retry" };
}

export async function processRefund(
  shop: string,
  refund: RefundPayload,
  deps: TrackingDeps,
): Promise<ProcessResult> {
  const orderId = String(refund.order_id);
  const base = {
    shop,
    type: "refund" as const,
    eventId: `refund-${refund.id}`,
    orderId,
  };

  const settings = await deps.getSettings(shop);
  if (!settings || !settings.trackRefunds) {
    await deps.logEvent({ ...base, status: "skipped", message: "not_configured" });
    return DONE;
  }

  // No money back (restock only) or shipping only: the commission stays as it is.
  const goods = refundedGoods(refund);
  if (!goods.ok) {
    await deps.logEvent({ ...base, status: "skipped", message: goods.reason });
    return DONE;
  }

  let sale: SaleAmounts | null = null;
  if (deps.getSaleRecord) {
    let record: SaleRecord | null = null;
    let lookupFailed = false;
    try {
      record = await deps.getSaleRecord(shop, orderId);
    } catch {
      // Without the record we simply send the refund; FirstPromoter answers 404 if needed.
      lookupFailed = true;
    }
    if (!lookupFailed) {
      // A sale that was skipped, not a referral or rejected has nothing to refund.
      if (record && ["skipped", "no_referral", "error"].includes(record.status)) {
        await deps.logEvent({ ...base, status: "skipped", message: "sale_not_tracked" });
        return DONE;
      }
      // The refund came first (or the sale is still being sent): Shopify redelivers it later.
      if (!record || record.status === "processing" || record.status === "retrying") {
        await deps.logEvent({ ...base, status: "retrying", message: "waiting_for_sale" });
        return { retry: true };
      }
      if (typeof record.amount === "number") {
        sale = {
          amount: record.amount,
          goodsPaid: record.goodsPaid ?? record.amount,
          refunded: deps.getRefundedAmount ? await deps.getRefundedAmount(shop, orderId) : 0,
        };
      }
    }
  }

  if (deps.claim) {
    try {
      if (!(await deps.claim(shop, "refund", base.eventId, orderId))) return DONE;
    } catch {
      return { retry: true };
    }
  }

  let orderName: string | null = null;
  if (deps.getOrderName) {
    try {
      orderName = await deps.getOrderName(shop, orderId);
    } catch (error) {
      // The sale was sent with the order number, so guessing would not match.
      const reason = error instanceof Error ? error.message : String(error);
      await deps.logEvent({
        ...base,
        status: "retrying",
        message: `order_lookup_failed: ${reason}`.slice(0, 200),
      });
      return { retry: true };
    }
  }

  const built = buildRefundBody(refund, orderName, sale);
  if (!built.ok) {
    await deps.logEvent({ ...base, status: "skipped", message: built.reason });
    return DONE;
  }

  const creds = credentialsFrom(settings);
  if (!creds) {
    await deps.logEvent({ ...base, status: "error", message: "credentials_unreadable" });
    return DONE;
  }

  const result = await (deps.track ?? track)("refund", creds, built.body);
  await deps.logEvent({
    ...base,
    amount: Number(built.body.amount),
    status: toStatus(result),
    httpStatus: result.status,
    message: result.message,
  });
  return { retry: result.outcome === "retry" };
}
