function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** Public origin Shopify uses for OAuth, App Bridge, and webhooks. No trailing slash. */
export function getAppUrl(): string {
  const raw =
    process.env.SHOPIFY_APP_URL?.trim() ||
    process.env.RENDER_EXTERNAL_URL?.trim() ||
    "";
  return raw.replace(/\/$/, "");
}

export function assertRequiredEnv() {
  if (process.env.NODE_ENV !== "production") return;

  required("SHOPIFY_API_KEY");
  required("SHOPIFY_API_SECRET");
  required("DATABASE_URL");

  if (!getAppUrl()) {
    throw new Error("SHOPIFY_APP_URL is not set");
  }

  const key = required("ENCRYPTION_KEY");
  if (Buffer.from(key, "base64").length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  }
}
