# FirstPromoter for Shopify

Shopify app that connects a store to FirstPromoter without any code in the theme.
The merchant enters Account ID and API key once (the Account ID doubles as the CID of the tracking script); the app does the rest.

| Piece | What it does |
| --- | --- |
| Theme app extension `firstpromoter-tracking` (app embed) | Loads `fpr.js`, records the click, and copies the visitor id (`_fprom_tid`) into the cart attribute `fp_tid`. Optionally waits for Shopify marketing consent. |
| Webhook `orders/paid` | `POST /track/sale` with `uid`, `email`, `event_id`, `amount` (cents, pre-tax), `currency`, `tid`. |
| Webhook `refunds/create` | `POST /track/refund` with `uid`, `event_id=refund-<id>`, `sale_event_id`, `amount`. |
| Settings page | Credentials (API key encrypted with AES-256-GCM), toggles, "Finish setup" banner until connected. |
| Activity page | Event log with All / Success / Skipped / Failed tabs, search, 20 rows per page. |
| Compliance webhooks | `customers/data_request`, `customers/redact`, `shop/redact`, `app/uninstalled`. |

This reproduces the manual setup that was verified by hand: theme script + Shopify Flow
`Order paid` → `/track/sale`. The app replaces both.

## Behaviour

- Sale: `404` from FirstPromoter means "not an affiliate order" and is logged, not retried.
  `409` means already tracked. `429`/`5xx`/timeout make the webhook answer `503` so Shopify redelivers.
  Other `4xx` (bad key, bad payload, `422` validation) are logged as errors on the settings page.
- Each sale and refund is reserved in the event log before it is sent, so parallel or repeated
  deliveries of the same webhook reach FirstPromoter once.
- Only orders tied to an affiliate are sent: an `fp_tid` from the affiliate link, or (when
  "track coupon codes" is on) a discount code. Everything else is skipped (`no_link_or_code`).
  If both exist, the setting "link first / code first" decides which is tried first; a 404 falls
  through to the other signal.
- Amount is `subtotal_price` (after discounts, before shipping and tax) in the shop currency.
  With tax-inclusive prices the line taxes are taken off.
- Refund amount is the money returned to the buyer minus refunded shipping, scaled to the
  commission base (no tax) and capped at what is left of the sale. Restock-only and
  shipping-only refunds are skipped. A refund that arrives before its sale answers `503`, so
  Shopify redelivers it once the sale is recorded.
- `uid` is the order number (e.g. `#1003`); `event_id` is the numeric order id. The refund webhook
  has no order number, so refunds look it up through the Admin API.
- The event log stores order ids and outcomes only, no customer data.

## Local development

```bash
cp .env.example .env          # fill in values
npm install
npx prisma generate
npx prisma migrate deploy     # needs DATABASE_URL (PostgreSQL)
npm test
npm run dev                   # Shopify CLI: tunnel, install on a dev store
```

Set `client_id` in `shopify.app.toml` (or run `npm run config:link`), then `npm run deploy`
to release the extension and webhook config.

## Production hosting (Render)

Do not use shared cPanel or Render **Free**: the process must stay up for Shopify webhooks.
This repo includes `render.yaml` (paid web service + Postgres).

1. Push the repo to GitHub and open [Render Blueprint](https://dashboard.render.com/blueprints).
2. Apply `render.yaml`. Use the **starter** web plan (not Free).
3. In the web service env vars, set:
   - `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` — production Partner app
   - `SHOPIFY_APP_URL` — `https://<service>.onrender.com` (no trailing slash)
   - `ENCRYPTION_KEY` — `openssl rand -base64 32` (save this; rotating it breaks stored API keys)
4. `DATABASE_URL` is filled from the Blueprint database. Confirm logs show `prisma migrate deploy` and `GET /health` → `ok`.
5. In Partners, set App URL and redirect URLs to that origin (`/auth/callback` and `/api/auth`).
6. Point the CLI at the production app, put the Render URL in `shopify.app.production.toml`, then:

```bash
npm run config:use -- shopify.app.production.toml
npm run deploy
```

`npm run deploy` publishes the theme extension and webhook subscriptions. It does not replace the Render deploy.

Local Docker (same process as Render, port 3000):

```bash
docker build -t firstpromoter-shopify .
docker run --env-file .env -p 3000:3000 firstpromoter-shopify
```

## Before submitting to the App Store

Not yet done or verified in this repository:

1. **Protected customer data.** The app reads order email. In the Partner Dashboard (API access →
   Protected customer data) request access and explain why; this is required for `orders/*`
   webhooks on public apps.
2. **`app.metafields.firstpromoter.cid` in Liquid.** The settings page writes the CID to an
   app-owned metafield on the app installation and the embed reads it. Confirm on a dev store.
3. **Theme editor deep link** (`activateAppId=<api key>/firstpromoter_embed`) – confirm it opens
   with the embed pre-selected.
4. **Duplicate-referral behaviour.** Verify with two affiliates and the same buyer email, and
   with the FirstPromoter setting "Allow Duplicate Referral Emails" on and off. Also verify that a
   refund sent with `uid` only is matched to a sale created with `uid` + `email`.
5. **Hosting ops**: monitoring and alerts on webhook 5xx rates. Rotate `ENCRYPTION_KEY` with a
   re-encryption script if ever needed.
6. **Listing assets**: privacy policy, support contact, screenshots, and an install guide.
7. **Review requirements**: Shopify's automated checks (Lighthouse impact of the app embed,
   billing if you charge, embedded admin UX).
8. Prisma client generation and the SQL migration were written without network access to
   Prisma's engine download; run `npx prisma generate` and `npx prisma migrate diff` to confirm
   the migration matches `schema.prisma`.
