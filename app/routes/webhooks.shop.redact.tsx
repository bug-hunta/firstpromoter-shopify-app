import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Mandatory compliance webhook, sent 48 hours after uninstall.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.webhook(request);

  await db.eventLog.deleteMany({ where: { shop } });
  await db.shopSettings.deleteMany({ where: { shop } });
  await db.session.deleteMany({ where: { shop } });

  return new Response();
};
