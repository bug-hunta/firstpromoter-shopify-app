import { beforeEach, describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../app/lib/crypto.server";

beforeEach(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
});

describe("crypto", () => {
  it("round-trips and never stores plaintext", () => {
    const secret = "fp-live-abc123";
    const sealed = encrypt(secret);
    expect(sealed).not.toContain(secret);
    expect(decrypt(sealed)).toBe(secret);
  });
  it("uses a fresh IV each time", () => {
    expect(encrypt("x")).not.toBe(encrypt("x"));
  });
  it("detects tampering", () => {
    const parts = encrypt("secret").split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decrypt(parts.join(":"))).toThrow();
  });
  it("rejects a missing or short key", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt("x")).toThrow(/not set/);
    process.env.ENCRYPTION_KEY = "c2hvcnQ=";
    expect(() => encrypt("x")).toThrow(/32 bytes/);
  });
});
