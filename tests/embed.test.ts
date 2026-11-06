import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const SCRIPT = readFileSync("extensions/firstpromoter-tracking/assets/firstpromoter.js", "utf8");

type Privacy = { marketingAllowed: () => boolean };

/**
 * Runs the storefront script in a bare window. "late" consent arrives through
 * Shopify.loadFeatures, the way Shopify loads the customer privacy API.
 */
function runEmbed(consent: { privacy?: Privacy; late?: Privacy; respectConsent?: boolean }) {
  const appended: string[] = [];
  const listeners: Record<string, Array<() => void>> = {};
  let loadFeaturesDone: (() => void) | undefined;
  const shopify: Record<string, unknown> = {};
  if (consent.privacy) shopify.customerPrivacy = consent.privacy;
  if (consent.late) {
    shopify.loadFeatures = (_features: unknown, done: (error?: unknown) => void) => {
      loadFeaturesDone = () => {
        shopify.customerPrivacy = consent.late;
        done();
      };
    };
  }
  const window: Record<string, unknown> = {
    __FPR_CONFIG: { cid: "abc", respectConsent: consent.respectConsent ?? true },
    Shopify: shopify,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ attributes: {} }) }),
    FormData: class {},
    addEventListener: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
    setTimeout,
  };
  window.window = window;
  window.document = {
    cookie: "",
    head: { appendChild: (el: { src: string }) => appended.push(el.src) },
    createElement: () => ({}),
    addEventListener: (name: string, fn: () => void) => (listeners[name] ??= []).push(fn),
  };
  runInNewContext(SCRIPT, window);
  return {
    tracking: () => appended.includes("https://cdn.firstpromoter.com/fpr.js"),
    finishLoading: () => loadFeaturesDone?.(),
    collectConsent: () => listeners.visitorConsentCollected?.forEach((fn) => fn()),
    shopify,
  };
}

const allow: Privacy = { marketingAllowed: () => true };
const deny: Privacy = { marketingAllowed: () => false };

describe("storefront script and marketing consent", () => {
  it("does not track when consent is denied", () => {
    expect(runEmbed({ privacy: deny }).tracking()).toBe(false);
  });
  it("tracks when consent is given", () => {
    expect(runEmbed({ privacy: allow }).tracking()).toBe(true);
  });
  it("waits for a consent API that loads late instead of assuming consent", () => {
    const embed = runEmbed({ late: deny });
    expect(embed.tracking()).toBe(false);
    embed.finishLoading();
    expect(embed.tracking()).toBe(false);
  });
  it("starts once the late consent API allows marketing", () => {
    const embed = runEmbed({ late: allow });
    expect(embed.tracking()).toBe(false);
    embed.finishLoading();
    expect(embed.tracking()).toBe(true);
  });
  it("starts after the visitor accepts in the banner", () => {
    const embed = runEmbed({ privacy: deny });
    embed.shopify.customerPrivacy = allow;
    embed.collectConsent();
    expect(embed.tracking()).toBe(true);
  });
  it("does not block when the store has no consent API at all", () => {
    expect(runEmbed({}).tracking()).toBe(true);
  });
  it("ignores consent when the merchant turned the setting off", () => {
    expect(runEmbed({ privacy: deny, respectConsent: false }).tracking()).toBe(true);
  });
});
