import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { prismaDeps } from "../lib/store.server";
import { processPaidOrder } from "../lib/tracking.server";
import type { OrderPayload } from "../lib/payloads";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const { retry } = await processPaidOrder(
    shop,
    payload as unknown as OrderPayload,
    prismaDeps,
  );

  // 5xx makes Shopify redeliver the webhook (FirstPromoter was unreachable).
  return new Response(null, { status: retry ? 503 : 200 });
};
