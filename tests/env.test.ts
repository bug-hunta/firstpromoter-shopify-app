import { afterEach, describe, expect, it } from "vitest";
import { assertRequiredEnv, getAppUrl } from "../app/env.server";

const keys = [
  "NODE_ENV",
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_APP_URL",
  "RENDER_EXTERNAL_URL",
  "DATABASE_URL",
  "ENCRYPTION_KEY",
] as const;

const snapshot = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("getAppUrl", () => {
  it("prefers SHOPIFY_APP_URL and strips a trailing slash", () => {
    process.env.SHOPIFY_APP_URL = "https://app.example.com/";
    process.env.RENDER_EXTERNAL_URL = "https://other.onrender.com";
    expect(getAppUrl()).toBe("https://app.example.com");
  });

  it("falls back to RENDER_EXTERNAL_URL", () => {
    delete process.env.SHOPIFY_APP_URL;
    process.env.RENDER_EXTERNAL_URL = "https://fp.onrender.com/";
    expect(getAppUrl()).toBe("https://fp.onrender.com");
  });
});

describe("assertRequiredEnv", () => {
  it("skips checks outside production", () => {
    process.env.NODE_ENV = "test";
    delete process.env.SHOPIFY_API_KEY;
    expect(() => assertRequiredEnv()).not.toThrow();
  });

  it("requires production secrets", () => {
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_API_KEY = "key";
    process.env.SHOPIFY_API_SECRET = "secret";
    process.env.DATABASE_URL = "postgresql://localhost/db";
    process.env.SHOPIFY_APP_URL = "https://app.example.com";
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
    expect(() => assertRequiredEnv()).not.toThrow();
  });

  it("rejects a short encryption key in production", () => {
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_API_KEY = "key";
    process.env.SHOPIFY_API_SECRET = "secret";
    process.env.DATABASE_URL = "postgresql://localhost/db";
    process.env.SHOPIFY_APP_URL = "https://app.example.com";
    process.env.ENCRYPTION_KEY = "c2hvcnQ=";
    expect(() => assertRequiredEnv()).toThrow(/32 bytes/);
  });
});
