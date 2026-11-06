import { toMinorUnits } from "./money";

type MoneySet = { shop_money?: { amount?: string; currency_code?: string } } | null;

/** Subset of the orders/paid webhook payload that we read. */
export interface OrderPayload {
  id: number | string;
  /** Merchant-facing order number, e.g. "#1003". */
  name?: string | null;
  email?: string | null;
  currency?: string | null;
  subtotal_price?: string | null;
  total_price?: string | null;
  total_tax?: string | null;
  /** Prices include tax (EU stores): subtotal_price then contains the tax too. */
  taxes_included?: boolean | null;
  total_shipping_price_set?: MoneySet;
  note_attributes?: Array<{ name?: string; value?: unknown }> | null;
  /** Line item properties carry fp_tid when the buyer used "Buy it now". */
  line_items?: Array<{
    properties?: Array<{ name?: string; value?: unknown }> | null;
    tax_lines?: Array<{ price?: string | null; price_set?: MoneySet }> | null;
  }> | null;
  discount_codes?: Array<{ code?: string | null }> | null;
}

/** Subset of the refunds/create webhook payload that we read. */
export interface RefundPayload {
  id: number | string;
  order_id: number | string;
  refund_line_items?: Array<{
    subtotal?: number | string | null;
    subtotal_set?: MoneySet;
  }> | null;
  refund_shipping_lines?: Array<{
    subtotal_amount_set?: MoneySet;
    amount_set?: MoneySet;
  }> | null;
  /** Money actually returned to the buyer. */
  transactions?: Array<{
    kind?: string | null;
    status?: string | null;
    amount?: string | number | null;
    currency?: string | null;
    amount_set?: MoneySet;
  }> | null;
}

/** What the app sent for the sale, kept so refunds can be scaled and capped. */
export interface SaleAmounts {
  /** Commission base sent to FirstPromoter (minor units). */
  amount: number;
  /** What the buyer paid for the goods: total minus shipping (minor units). */
  goodsPaid: number;
  /** Refund amounts already sent for this order (minor units). */
  refunded: number;
}

export interface SaleBody {
  uid: string;
  email?: string;
  event_id: string;
  amount: number;
  currency?: string;
  tid?: string;
  promo_code?: string;
}

export interface RefundBody {
  uid: string;
  event_id: string;
  sale_event_id: string;
  amount: string;
  currency?: string;
}

export type Built<T> =
  | { ok: true; body: T }
  | { ok: false; reason: string };

function readTid(list: Array<{ name?: string; value?: unknown }> | null | undefined, names: string[]): string | null {
  for (const entry of list ?? []) {
    if (entry?.name && names.includes(entry.name) && typeof entry.value === "string") {
      const value = entry.value.trim();
      if (value) return value;
    }
  }
  return null;
}

/**
 * Reads the visitor id saved by the storefront script: the cart attribute
 * fp_tid (normal checkout), or the hidden line item property _fp_tid, which
 * also survives "Buy it now" because that button skips the cart.
 */
export function extractTid(order: OrderPayload): string | null {
  const fromCart = readTid(order.note_attributes, ["fp_tid"]);
  if (fromCart) return fromCart;
  for (const item of order.line_items ?? []) {
    const fromItem = readTid(item?.properties, ["_fp_tid", "fp_tid"]);
    if (fromItem) return fromItem;
  }
  return null;
}

/** Discount codes the buyer used (deduplicated, at most two are tried). */
export function extractCodes(order: OrderPayload): string[] {
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const entry of order.discount_codes ?? []) {
    const code = typeof entry?.code === "string" ? entry.code.trim() : "";
    if (!code || seen.has(code.toLowerCase())) continue;
    seen.add(code.toLowerCase());
    codes.push(code);
  }
  return codes.slice(0, 2);
}

export type CouponPriority = "link" | "code";

export interface SaleOptions {
  trackCoupons: boolean;
  /** Which signal is tried first when an order has both a link and a code. */
  couponPriority: CouponPriority;
}

/**
 * Ordered list of sale requests to try. FirstPromoter answers 404 when a
 * signal does not belong to an affiliate, so the next one is tried then.
 */
export function buildSaleAttempts(
  order: OrderPayload,
  options: SaleOptions,
): Built<SaleBody[]> {
  const amount = saleAmount(order);
  if (amount === null) return { ok: false, reason: "invalid_amount" };
  if (amount <= 0) return { ok: false, reason: "zero_amount" };

  // uid is the readable order number ("#1003") so it is easy to find in
  // FirstPromoter and Shopify. event_id stays the numeric id: it never changes.
  const orderId = String(order.id);
  const base: SaleBody = {
    uid: order.name?.trim() || orderId,
    event_id: orderId,
    amount,
  };
  if (order.email) base.email = order.email;
  if (order.currency) base.currency = order.currency;

  const tid = extractTid(order);
  const link: SaleBody[] = tid ? [{ ...base, tid }] : [];
  const codes: SaleBody[] = options.trackCoupons
    ? extractCodes(order).map((promo_code) => ({ ...base, promo_code }))
    : [];

  const attempts =
    options.couponPriority === "code" ? [...codes, ...link] : [...link, ...codes];

  // Only orders tied to an affiliate (link or code) are ever sent.
  if (attempts.length === 0) return { ok: false, reason: "no_link_or_code" };
  return { ok: true, body: attempts };
}

const moneyOf = (set: MoneySet | undefined, fallback?: string | number | null) =>
  set?.shop_money?.amount ?? (fallback === undefined || fallback === null ? undefined : String(fallback));

/**
 * Commission base: subtotal_price (after discounts, before shipping). With
 * tax-inclusive prices the subtotal contains the line taxes, which are removed.
 * Null when the payload has no usable amount.
 */
export function saleAmount(order: OrderPayload): number | null {
  try {
    const subtotal = toMinorUnits(order.subtotal_price ?? "", order.currency);
    if (!order.taxes_included) return subtotal;
    let tax = 0;
    let hasLineTax = false;
    for (const line of order.line_items ?? []) {
      for (const taxLine of line.tax_lines ?? []) {
        const value = moneyOf(taxLine.price_set, taxLine.price);
        if (value === undefined) continue;
        tax += toMinorUnits(value, order.currency);
        hasLineTax = true;
      }
    }
    if (!hasLineTax && order.total_tax) tax = toMinorUnits(order.total_tax, order.currency);
    return Math.max(subtotal - tax, 0);
  } catch {
    return null;
  }
}

/** What the buyer paid for the goods (total minus shipping); null if unknown. */
export function goodsPaid(order: OrderPayload): number | null {
  try {
    const total = toMinorUnits(order.total_price ?? "", order.currency);
    const shipping = moneyOf(order.total_shipping_price_set);
    return total - (shipping ? toMinorUnits(shipping, order.currency) : 0);
  } catch {
    return null;
  }
}

/**
 * Goods money the buyer got back: successful refund transactions minus the
 * refunded shipping. A refund that returns no money (restock only) or only
 * shipping changes nothing in FirstPromoter.
 */
export function refundedGoods(refund: RefundPayload): Built<{ minor: number; currency?: string }> {
  let currency: string | undefined;
  const add = (value: string | undefined, code?: string | null) => {
    currency ??= code ?? undefined;
    return value === undefined ? 0 : toMinorUnits(value, code ?? currency);
  };
  try {
    let money = 0;
    if (refund.transactions) {
      for (const tx of refund.transactions) {
        if (tx.kind !== "refund" || (tx.status && tx.status !== "success")) continue;
        money += add(moneyOf(tx.amount_set, tx.amount), tx.amount_set?.shop_money?.currency_code ?? tx.currency);
      }
    } else {
      // Older payloads without transactions: the refunded line subtotals.
      for (const line of refund.refund_line_items ?? []) {
        money += add(moneyOf(line.subtotal_set, line.subtotal), line.subtotal_set?.shop_money?.currency_code);
      }
    }
    if (money <= 0) return { ok: false, reason: "no_money_refunded" };
    let shipping = 0;
    for (const line of refund.refund_shipping_lines ?? []) {
      shipping += add(moneyOf(line.subtotal_amount_set ?? line.amount_set));
    }
    const minor = money - shipping;
    if (minor <= 0) return { ok: false, reason: "shipping_only" };
    return { ok: true, body: { minor, currency } };
  } catch {
    return { ok: false, reason: "invalid_amount" };
  }
}

/**
 * orderName must be the same value the sale used as uid (the refund webhook
 * does not carry it, so the caller looks it up). Falls back to the numeric id.
 * With the sale's amounts the refund is scaled to the commission base (no tax)
 * and capped so the commission never goes below zero.
 */
export function buildRefundBody(
  refund: RefundPayload,
  orderName?: string | null,
  sale?: SaleAmounts | null,
): Built<RefundBody> {
  const goods = refundedGoods(refund);
  if (!goods.ok) return goods;
  let minor = goods.body.minor;
  if (sale) {
    if (sale.goodsPaid > 0) minor = Math.round((minor * sale.amount) / sale.goodsPaid);
    minor = Math.min(minor, sale.amount - sale.refunded);
    if (minor <= 0) return { ok: false, reason: "nothing_left_to_refund" };
  }

  const orderId = String(refund.order_id);
  const body: RefundBody = {
    uid: orderName?.trim() || orderId,
    event_id: `refund-${refund.id}`,
    sale_event_id: orderId,
    amount: String(minor),
  };
  if (goods.body.currency) body.currency = goods.body.currency;
  return { ok: true, body };
}
