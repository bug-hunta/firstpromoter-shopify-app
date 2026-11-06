import { describe, expect, it, vi } from "vitest";
import { track, verifyCredentials } from "../app/lib/firstpromoter.server";

const creds = { accountId: "acc1", apiKey: "secret-key-123" };
const reply = (status: number, body: unknown = {}) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe("track", () => {
  it("posts to the sale endpoint with the documented headers", async () => {
    const fetchImpl = reply(200);
    await track("sale", creds, { uid: "1" }, { fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.firstpromoter.com/api/v2/track/sale");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer secret-key-123",
      "Account-ID": "acc1",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({ uid: "1" });
  });
  it("uses the refund endpoint", async () => {
    const fetchImpl = reply(200);
    await track("refund", creds, {}, { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://api.firstpromoter.com/api/v2/track/refund",
    );
  });
  it.each([
    [200, "tracked"],
    [404, "no_referral"],
    [409, "duplicate"],
    [422, "error"],
    [429, "retry"],
    [502, "retry"],
    [400, "error"],
    [401, "error"],
  ])("maps HTTP %i to %s", async (status, outcome) => {
    const result = await track("sale", creds, {}, { fetchImpl: reply(status) });
    expect(result.outcome).toBe(outcome);
    expect(result.status).toBe(status);
  });
  it("surfaces the API message for errors", async () => {
    const result = await track("sale", creds, {}, {
      fetchImpl: reply(400, { message: "Error. Amount blank or invalid." }),
    });
    expect(result.message).toBe("Error. Amount blank or invalid.");
  });
  it("retries on network errors and timeouts", async () => {
    const boom = vi.fn().mockRejectedValue(new Error("down"));
    expect((await track("sale", creds, {}, { fetchImpl: boom })).outcome).toBe("retry");

    const hang = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init.signal!.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        ),
      ),
    );
    const result = await track("sale", creds, {}, { fetchImpl: hang as never, timeoutMs: 20 });
    expect(result.outcome).toBe("retry");
  });
});

describe("verifyCredentials", () => {
  it("is valid on 200, invalid on 401/403/404, unknown otherwise", async () => {
    expect((await verifyCredentials(creds, { fetchImpl: reply(200) })).valid).toBe(true);
    expect((await verifyCredentials(creds, { fetchImpl: reply(401) })).valid).toBe(false);
    expect((await verifyCredentials(creds, { fetchImpl: reply(403) })).valid).toBe(false);
    // FirstPromoter answers 404 for an unknown Account ID.
    expect((await verifyCredentials(creds, { fetchImpl: reply(404) })).valid).toBe(false);
    expect((await verifyCredentials(creds, { fetchImpl: reply(500) })).valid).toBeNull();
    const down = vi.fn().mockRejectedValue(new Error("x"));
    expect((await verifyCredentials(creds, { fetchImpl: down })).valid).toBeNull();
  });
});

import { beforeEach } from "vitest";
import { buildCodeIndex, clearCodeCache, lookupPromoCode } from "../app/lib/firstpromoter.server";

describe("lookupPromoCode", () => {
  beforeEach(() => clearCodeCache());
  const campaigns = [
    { id: 1, state: "accepted", ref_token: "ynmf2k", promo_codes: ["Ben10", "Ben25"] },
    { id: 2, state: "accepted", ref_token: "changedtoken", promo_codes: [] },
    { id: 3, state: "blocked", ref_token: "bad", promo_codes: ["Bad10"] },
  ];
  const creds = { accountId: "acc", apiKey: "k" };

  it("indexes codes of accepted promoters only, case-insensitively", () => {
    const index = buildCodeIndex(campaigns);
    expect(index.get("ben10")).toBe("ynmf2k");
    expect(index.has("bad10")).toBe(false);
  });
  it("resolves a code to the ref token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => campaigns });
    expect(await lookupPromoCode(creds, "BEN10", { fetchImpl: fetchImpl as never })).toEqual({
      status: "found",
      refId: "ynmf2k",
    });
  });
  it("answers unknown for a code nobody owns and caches the list", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => campaigns });
    expect(await lookupPromoCode(creds, "PLAIN10", { fetchImpl: fetchImpl as never })).toEqual({ status: "unknown" });
    await lookupPromoCode(creds, "Ben10", { fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("reports an error when FirstPromoter fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const result = await lookupPromoCode(creds, "Ben10", { fetchImpl: fetchImpl as never });
    expect(result.status).toBe("error");
  });
});
