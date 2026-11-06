// FirstPromoter wants amounts in cents, except for zero-decimal currencies
// (e.g. JPY), which are sent as whole values.
const ZERO_DECIMAL = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA",
  "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

export function isZeroDecimal(currency?: string | null): boolean {
  return !!currency && ZERO_DECIMAL.has(currency.toUpperCase());
}

/**
 * Converts a decimal money string ("19.99") to FirstPromoter's integer unit.
 * Uses string maths so "1.005" style values never hit float rounding errors.
 * Throws on anything that is not a non-negative decimal.
 */
export function toMinorUnits(
  amount: string | number,
  currency?: string | null,
): number {
  const text = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`Invalid money amount: ${text}`);
  }
  const [whole, fraction = ""] = text.split(".");

  if (isZeroDecimal(currency)) {
    return Number(whole) + (fraction && Number(fraction[0]) >= 5 ? 1 : 0);
  }

  const cents = (fraction + "00").slice(0, 2);
  const roundUp = fraction.length > 2 && Number(fraction[2]) >= 5 ? 1 : 0;
  return Number(whole) * 100 + Number(cents) + roundUp;
}

/** Adds decimal money strings without float drift; returns a 2dp string. */
export function sumMoney(values: Array<string | number>): string {
  let cents = 0;
  for (const value of values) {
    cents += toMinorUnits(value, null);
  }
  const whole = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, "0");
  return `${whole}.${rest}`;
}
