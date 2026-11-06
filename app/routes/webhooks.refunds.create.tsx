import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { prismaDeps } from "../lib/store.server";
import { processRefund } from "../lib/tracking.server";
import type { RefundPayload } from "../lib/payloads";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const { retry } = await processRefund(
    shop,
    payload as unknown as RefundPayload,
    prismaDeps,
  );

  return new Response(null, { status: retry ? 503 : 200 });
};
