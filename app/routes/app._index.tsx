import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { decrypt, encrypt } from "../lib/crypto.server";
import { verifyCredentials } from "../lib/firstpromoter.server";
import {
  parseSettingsForm,
  validateSettings,
  type FieldErrors,
} from "../lib/settings";

const EMBED_HANDLE = "firstpromoter_embed";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const settings = await db.shopSettings.findUnique({
    where: { shop: session.shop },
  });

  return {
    configured: !!settings,
    accountId: settings?.accountId ?? "",
    trackCoupons: settings?.trackCoupons ?? true,
    couponPriority: settings?.couponPriority === "code" ? "code" : "link",
    trackSales: settings?.trackSales ?? true,
    trackRefunds: settings?.trackRefunds ?? true,
    embedUrl: `https://${session.shop}/admin/themes/current/editor?context=apps&activateAppId=${process.env.SHOPIFY_API_KEY}/${EMBED_HANDLE}`,
  };
};

type ActionResult =
  | { ok: true; warning?: string }
  | { ok: false; errors: FieldErrors; message?: string };

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionResult> => {
  const { admin, session } = await authenticate.admin(request);
  const input = parseSettingsForm(await request.formData());

  const existing = await db.shopSettings.findUnique({
    where: { shop: session.shop },
  });
  const errors = validateSettings(input, { hasStoredKey: !!existing });
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const apiKey = input.apiKey || decrypt(existing!.apiKeyEnc);
  const check = await verifyCredentials({ accountId: input.accountId, apiKey });
  if (check.valid === false) {
    return {
      ok: false,
      errors: {
        apiKey:
          "FirstPromoter rejected these credentials. Check the Account ID and API key.",
      },
    };
  }

  const data = {
    accountId: input.accountId,
    trackCoupons: input.trackCoupons,
    couponPriority: input.couponPriority,
    trackSales: input.trackSales,
    trackRefunds: input.trackRefunds,
    ...(input.apiKey ? { apiKeyEnc: encrypt(input.apiKey) } : {}),
  };
  await db.shopSettings.upsert({
    where: { shop: session.shop },
    create: { shop: session.shop, ...data, apiKeyEnc: encrypt(apiKey) },
    update: data,
  });

  // The storefront script reads the CID (= Account ID) from an app metafield.
  const installation = await admin.graphql(
    `#graphql
    query currentInstallation { currentAppInstallation { id } }`,
  );
  const installationId = (await installation.json()).data
    ?.currentAppInstallation?.id as string | undefined;

  let warning: string | undefined;
  if (!installationId) {
    warning =
      "Settings saved, but the store could not be updated. Please save again.";
  } else {
    const response = await admin.graphql(
      `#graphql
      mutation setCid($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              ownerId: installationId,
              namespace: "firstpromoter",
              key: "cid",
              type: "single_line_text_field",
              value: input.accountId,
            },
          ],
        },
      },
    );
    const userErrors = (await response.json()).data?.metafieldsSet?.userErrors;
    if (userErrors?.length) {
      warning =
        "Settings saved, but the tracking CID could not be published to your store.";
    }
  }

  if (check.valid === null) {
    warning ??=
      "Saved. FirstPromoter could not be reached to verify the credentials.";
  }
  return { ok: true, warning };
};

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResult>();
  const saving = fetcher.state !== "idle";

  const [accountId, setAccountId] = useState(data.accountId);
  const [apiKey, setApiKey] = useState("");
  const [trackCoupons, setTrackCoupons] = useState(data.trackCoupons);
  const [couponPriority, setCouponPriority] = useState<string>(
    data.couponPriority,
  );
  const [trackSales, setTrackSales] = useState(data.trackSales);
  const [trackRefunds, setTrackRefunds] = useState(data.trackRefunds);

  const result = fetcher.data;
  const errors = result && !result.ok ? result.errors : {};

  // Clear the key field once per successful save.
  const [handledResult, setHandledResult] = useState(result);
  if (result !== handledResult) {
    setHandledResult(result);
    if (result?.ok) setApiKey("");
  }

  const save = () => {
    const form = new FormData();
    form.set("accountId", accountId);
    form.set("apiKey", apiKey);
    form.set("trackCoupons", String(trackCoupons));
    form.set("couponPriority", couponPriority);
    form.set("trackSales", String(trackSales));
    form.set("trackRefunds", String(trackRefunds));
    fetcher.submit(form, { method: "post" });
  };

  return (
    <s-page heading="FirstPromoter">
      <s-button
        slot="primary-action"
        onClick={save}
        {...(saving ? { loading: true } : {})}
      >
        Save
      </s-button>

      {result?.ok && !result.warning && (
        <s-banner tone="success" heading="Settings saved" />
      )}
      {result?.ok && result.warning && (
        <s-banner tone="warning" heading="Saved with a warning">
          {result.warning}
        </s-banner>
      )}

      {!data.configured && (
        <s-banner tone="info" heading="Finish setup">
          Connect your FirstPromoter account (step 1) and turn on the app embed
          in your theme (step 2). Referrals are tracked once both are done.
        </s-banner>
      )}

      <s-section heading="1. Connect your FirstPromoter account">
        <s-stack gap="base">
          <s-paragraph>
            Find these values in FirstPromoter under Settings → Integrations.
          </s-paragraph>
          <s-text-field
            label="Account ID"
            value={accountId}
            error={errors.accountId}
            onInput={(e) => setAccountId(e.currentTarget.value)}
          />
          <s-password-field
            label="API key"
            value={apiKey}
            placeholder={
              data.configured ? "Saved. Enter a new key to replace it." : ""
            }
            error={errors.apiKey}
            onInput={(e) => setApiKey(e.currentTarget.value)}
          />
        </s-stack>
      </s-section>

      <s-section heading="2. Turn on tracking in your theme">
        <s-stack gap="base">
          <s-paragraph>
            Enable the “FirstPromoter tracking” app embed. It loads the tracking
            script and attaches the affiliate to the cart, so no code needs to
            be pasted into your theme.
          </s-paragraph>
          <s-box>
            <s-button href={data.embedUrl} target="_blank" icon="external">
              Open theme editor
            </s-button>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading="3. What to track">
        <s-stack gap="base">
          <s-checkbox
            label="Track paid orders as sales"
            checked={trackSales}
            onChange={(e) => setTrackSales(e.currentTarget.checked)}
          />
          <s-checkbox
            label="Track refunds (reverses the commission)"
            checked={trackRefunds}
            onChange={(e) => setTrackRefunds(e.currentTarget.checked)}
          />
          <s-checkbox
            label="Also track orders that used an affiliate coupon code (orders without an affiliate link or code are never sent)"
            checked={trackCoupons}
            onChange={(e) => setTrackCoupons(e.currentTarget.checked)}
          />
          <s-select
            label="If an order has both an affiliate link and a coupon code, use the"
            value={couponPriority}
            {...(trackCoupons ? {} : { disabled: true })}
            onChange={(e) => setCouponPriority(e.currentTarget.value)}
          >
            <s-option value="link">
              Affiliate link first (code is the fallback)
            </s-option>
            <s-option value="code">
              Coupon code first (link is the fallback)
            </s-option>
          </s-select>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
