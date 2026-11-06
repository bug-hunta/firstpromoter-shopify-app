import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// Mandatory compliance webhook. This app stores no customer data: the event
// log keeps order ids and outcomes only, and customer emails are forwarded to
// FirstPromoter without being stored here.
export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.webhook(request);
  return new Response();
};
