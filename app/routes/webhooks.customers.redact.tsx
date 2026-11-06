import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// Mandatory compliance webhook. Nothing to delete: no customer data is stored.
export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.webhook(request);
  return new Response();
};
