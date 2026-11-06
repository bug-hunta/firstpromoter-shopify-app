export interface SettingsInput {
  accountId: string;
  apiKey: string;
  trackCoupons: boolean;
  couponPriority: "link" | "code";
  trackSales: boolean;
  trackRefunds: boolean;
}

export type FieldErrors = Partial<Record<keyof SettingsInput, string>>;

// Account ID (also the CID of the tracking script) looks like "014waxs2": short alphanumeric tokens.
const TOKEN = /^[A-Za-z0-9_-]{2,64}$/;

export function parseSettingsForm(form: FormData): SettingsInput {
  const text = (name: string) => String(form.get(name) ?? "").trim();
  return {
    accountId: text("accountId"),
    apiKey: text("apiKey"),
    trackCoupons: form.get("trackCoupons") !== "false",
    couponPriority: form.get("couponPriority") === "code" ? "code" : "link",
    trackSales: form.get("trackSales") === "true",
    trackRefunds: form.get("trackRefunds") === "true",
  };
}

export function validateSettings(
  input: SettingsInput,
  options: { hasStoredKey: boolean },
): FieldErrors {
  const errors: FieldErrors = {};
  if (!TOKEN.test(input.accountId)) {
    errors.accountId = "Enter the Account ID from FirstPromoter (Settings → Integrations).";
  }
  if (!input.apiKey && !options.hasStoredKey) {
    errors.apiKey = "Enter an API key (Settings → Integrations → Manage API Keys).";
  } else if (input.apiKey && (input.apiKey.length < 8 || /\s/.test(input.apiKey))) {
    errors.apiKey = "This does not look like an API key.";
  }
  return errors;
}
