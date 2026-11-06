import { describe, expect, it } from "vitest";
import { parseSettingsForm, validateSettings } from "../app/lib/settings";

const ok = { accountId: "014waxs2", apiKey: "abcdefgh12", trackCoupons: true, couponPriority: "link" as const, trackSales: true, trackRefunds: true };

describe("validateSettings", () => {
  it("accepts valid input", () => {
    expect(validateSettings(ok, { hasStoredKey: false })).toEqual({});
  });
  it("requires an API key only on first save", () => {
    expect(validateSettings({ ...ok, apiKey: "" }, { hasStoredKey: false }).apiKey).toBeDefined();
    expect(validateSettings({ ...ok, apiKey: "" }, { hasStoredKey: true })).toEqual({});
  });
  it("rejects malformed ids and keys", () => {
    const errors = validateSettings({ ...ok, accountId: "a b", apiKey: "x y z 1234" }, { hasStoredKey: false });
    expect(Object.keys(errors).sort()).toEqual(["accountId", "apiKey"]);
  });
});

describe("parseSettingsForm", () => {
  it("trims text and parses booleans", () => {
    const form = new FormData();
    form.set("accountId", " abc ");
    form.set("trackSales", "true");
    const parsed = parseSettingsForm(form);
    expect(parsed.accountId).toBe("abc");
    expect(parsed.trackSales).toBe(true);
  });
  it("defaults coupon tracking on and the priority to the link", () => {
    const parsed = parseSettingsForm(new FormData());
    expect(parsed.trackCoupons).toBe(true);
    expect(parsed.couponPriority).toBe("link");
  });
  it("accepts code priority and ignores unknown values", () => {
    const form = new FormData();
    form.set("couponPriority", "code");
    form.set("trackCoupons", "false");
    expect(parseSettingsForm(form)).toMatchObject({ couponPriority: "code", trackCoupons: false });
    form.set("couponPriority", "whatever");
    expect(parseSettingsForm(form).couponPriority).toBe("link");
  });
});
