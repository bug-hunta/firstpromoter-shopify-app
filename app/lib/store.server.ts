import { Prisma } from "@prisma/client";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import type { EventStatus, TrackingDeps } from "./tracking.server";

const LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
// A reservation older than this belongs to a request that died mid-way.
const PROCESSING_TIMEOUT_MS = 60 * 1000;
// Outcomes that did not reach FirstPromoter, so a redelivery may send again.
const RECLAIMABLE: EventStatus[] = ["retrying", "error", "skipped"];

/** Prisma-backed implementation of TrackingDeps. */
export const prismaDeps: TrackingDeps = {
  async getSettings(shop) {
    return db.shopSettings.findUnique({
      where: { shop },
      select: {
        accountId: true,
        apiKeyEnc: true,
        trackCoupons: true,
        couponPriority: true,
        trackSales: true,
        trackRefunds: true,
      },
    });
  },

  async getOrderName(shop, orderId) {
    const { admin } = await unauthenticated.admin(shop);
    const response = await admin.graphql(
      `#graphql
      query OrderName($id: ID!) {
        order(id: $id) { name }
      }`,
      { variables: { id: `gid://shopify/Order/${orderId}` } },
    );
    const json = (await response.json()) as {
      data?: { order?: { name?: string } | null };
      errors?: Array<{ message?: string }>;
    };
    // Access problems come back as GraphQL errors, not as an exception.
    if (json.errors?.length) {
      throw new Error(json.errors.map((e) => e.message).join("; "));
    }
    return json.data?.order?.name ?? null;
  },

  async claim(shop, type, eventId, orderId) {
    try {
      await db.eventLog.create({ data: { shop, type, eventId, orderId, status: "processing" } });
      return true;
    } catch (error) {
      const duplicate = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
      if (!duplicate) throw error;
    }
    // The unique index serialises parallel deliveries: only one update can match.
    const { count } = await db.eventLog.updateMany({
      where: {
        shop,
        type,
        eventId,
        OR: [
          { status: { in: RECLAIMABLE } },
          { status: "processing", updatedAt: { lt: new Date(Date.now() - PROCESSING_TIMEOUT_MS) } },
        ],
      },
      data: { status: "processing" },
    });
    return count === 1;
  },

  async getSaleRecord(shop, orderId) {
    const row = await db.eventLog.findUnique({
      where: { shop_type_eventId: { shop, type: "sale", eventId: orderId } },
      select: { status: true, message: true, amount: true, goodsPaid: true },
    });
    return row ? { ...row, status: row.status as EventStatus } : null;
  },

  async getRefundedAmount(shop, orderId) {
    const { _sum } = await db.eventLog.aggregate({
      where: { shop, orderId, type: "refund", status: { in: ["tracked", "duplicate"] } },
      _sum: { amount: true },
    });
    return _sum.amount ?? 0;
  },

  async logEvent(entry) {
    const data = {
      orderId: entry.orderId,
      status: entry.status,
      httpStatus: entry.httpStatus ?? null,
      message: entry.message?.slice(0, 300) ?? null,
      ...(entry.amount !== undefined ? { amount: entry.amount } : {}),
      ...(entry.goodsPaid !== undefined ? { goodsPaid: entry.goodsPaid } : {}),
    };
    try {
      await db.eventLog.upsert({
        where: {
          shop_type_eventId: {
            shop: entry.shop,
            type: entry.type,
            eventId: entry.eventId,
          },
        },
        create: { shop: entry.shop, type: entry.type, eventId: entry.eventId, ...data },
        update: data,
      });
      // Retention: keep the activity log for 90 days only.
      await db.eventLog.deleteMany({
        where: {
          shop: entry.shop,
          createdAt: { lt: new Date(Date.now() - LOG_RETENTION_MS) },
        },
      });
    } catch (error) {
      // The audit log must never make a webhook fail.
      console.error("Could not write event log", error);
    }
  },
};
