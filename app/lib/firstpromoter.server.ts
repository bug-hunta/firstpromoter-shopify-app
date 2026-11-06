// FP_API_BASE points the app at a mock FirstPromoter in tests.
const BASE_URL = process.env.FP_API_BASE || "https://api.firstpromoter.com/api/v2";

export interface Credentials {
  accountId: string;
  apiKey: string;
}

/**
 * tracked      - FirstPromoter recorded the event (2xx)
 * no_referral  - 404: the order does not belong to any affiliate (expected)
 * duplicate    - 409: event_id was already tracked
 * retry        - 429 / 5xx / network / timeout: ask Shopify to redeliver
 * error        - 4xx the merchant has to fix (bad key, bad payload, 422 validation...)
 */
export type Outcome =
  | "tracked"
  | "no_referral"
  | "duplicate"
  | "retry"
  | "error";

export interface CallResult {
  outcome: Outcome;
  status?: number;
  message?: string;
}

type FetchLike = typeof fetch;

function headers(creds: Credentials): Record<string, string> {
  return {
    Authorization: `Bearer ${creds.apiKey}`,
    "Account-ID": creds.accountId,
    "Content-Type": "application/json",
  };
}

async function readMessage(response: Response): Promise<string | undefined> {
  try {
    const data = (await response.json()) as { message?: unknown };
    return typeof data.message === "string" ? data.message : undefined;
  } catch {
    return undefined;
  }
}

function classify(status: number): Outcome {
  if (status >= 200 && status < 300) return "tracked";
  if (status === 404) return "no_referral";
  if (status === 409) return "duplicate";
  if (status === 429 || status >= 500) return "retry";
  return "error";
}

export async function track(
  kind: "sale" | "refund" | "signup",
  creds: Credentials,
  body: object,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<CallResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // Shopify expects a webhook answer within 5 seconds.
  const timeoutMs = options.timeoutMs ?? 4000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${BASE_URL}/track/${kind}`, {
      method: "POST",
      headers: headers(creds),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const outcome = classify(response.status);
    const message =
      outcome === "tracked" ? undefined : await readMessage(response);
    return { outcome, status: response.status, message };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      outcome: "retry",
      message: aborted ? "FirstPromoter did not answer in time" : "Network error",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Cheap authenticated read used to validate credentials on save. */
export async function verifyCredentials(
  creds: Credentials,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<{ valid: boolean | null; status?: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  try {
    const response = await fetchImpl(
      `${BASE_URL}/company/promoters?per_page=1`,
      { method: "GET", headers: headers(creds), signal: controller.signal },
    );
    // 404: FirstPromoter does not know this Account ID.
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return { valid: false, status: response.status };
    }
    if (response.ok) return { valid: true, status: response.status };
    // Anything else: we cannot tell, so do not block saving.
    return { valid: null, status: response.status };
  } catch {
    return { valid: null };
  } finally {
    clearTimeout(timer);
  }
}

export type CodeLookup =
  | { status: "found"; refId: string }
  | { status: "unknown" }
  | { status: "error"; message: string };

const CODE_CACHE_TTL_MS = 5 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const codeCache = new Map<string, { at: number; index: Map<string, string> }>();

/** Test helper: forget cached promo codes. */
export function clearCodeCache(): void {
  codeCache.clear();
}

interface CampaignLike {
  id?: unknown;
  state?: unknown;
  ref_token?: unknown;
  coupon?: unknown;
  display_coupon?: unknown;
  promo_codes?: unknown;
}

/** code (lowercase) -> the promoter's ref_token, for accepted promoters only. */
export function buildCodeIndex(campaigns: CampaignLike[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const campaign of campaigns) {
    if (typeof campaign?.ref_token !== "string" || !campaign.ref_token) continue;
    if (typeof campaign.state === "string" && campaign.state !== "accepted") continue;
    const codes: unknown[] = [campaign.coupon, campaign.display_coupon];
    if (Array.isArray(campaign.promo_codes)) codes.push(...campaign.promo_codes);
    for (const code of codes) {
      if (typeof code === "string" && code.trim()) {
        index.set(code.trim().toLowerCase(), campaign.ref_token);
      }
    }
  }
  return index;
}

async function loadCodeIndex(
  creds: Credentials,
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const campaigns: CampaignLike[] = [];
  let firstIdOfPreviousPage: unknown = undefined;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await fetchImpl(
      `${BASE_URL}/company/promoter_campaigns?per_page=${PAGE_SIZE}&page=${page}`,
      { method: "GET", headers: headers(creds), signal },
    );
    if (!response.ok) throw new Error(`promoter_campaigns answered ${response.status}`);
    const json = (await response.json()) as unknown;
    const list = (Array.isArray(json)
      ? json
      : (json as { data?: unknown })?.data) as CampaignLike[] | undefined;
    if (!Array.isArray(list) || list.length === 0) break;
    // An endpoint that ignores paging returns the same page again: stop.
    if (page > 1 && list[0]?.id !== undefined && list[0].id === firstIdOfPreviousPage) break;
    firstIdOfPreviousPage = list[0]?.id;
    campaigns.push(...list);
    if (list.length < PAGE_SIZE) break;
  }
  return buildCodeIndex(campaigns);
}

/**
 * Finds the promoter a discount code belongs to. FirstPromoter's sale call
 * needs a lead or a promoter: a code alone gets a 404, so we resolve it to the
 * promoter's referral token (ref_id) and send that instead.
 */
export async function lookupPromoCode(
  creds: Credentials,
  code: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number; now?: () => number } = {},
): Promise<CodeLookup> {
  const now = options.now ?? Date.now;
  const key = creds.accountId;
  const cached = codeCache.get(key);
  const wanted = code.trim().toLowerCase();
  if (cached && now() - cached.at < CODE_CACHE_TTL_MS) {
    const refId = cached.index.get(wanted);
    if (refId) return { status: "found", refId };
    // A code created a minute ago is not in the cache yet: look once more
    // unless the cache is very fresh.
    if (now() - cached.at < 30_000) return { status: "unknown" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4000);
  try {
    const index = await loadCodeIndex(creds, fetchImpl, controller.signal);
    codeCache.set(key, { at: now(), index });
    const refId = index.get(wanted);
    return refId ? { status: "found", refId } : { status: "unknown" };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      status: "error",
      message: aborted ? "FirstPromoter did not answer in time" : error instanceof Error ? error.message : "lookup failed",
    };
  } finally {
    clearTimeout(timer);
  }
}
