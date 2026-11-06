import { useEffect, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import type { Prisma } from "@prisma/client";

const PAGE_SIZE = 20;

const TABS = {
  all: { label: "All", tone: "info", statuses: null },
  success: {
    label: "Success",
    tone: "success",
    statuses: ["tracked", "duplicate"],
  },
  skipped: {
    label: "Skipped",
    tone: "neutral",
    statuses: ["no_referral", "skipped"],
  },
  failed: {
    label: "Failed",
    tone: "critical",
    statuses: ["error", "retrying"],
  },
} as const;

type Tab = keyof typeof TABS;

const isTab = (value: string | null): value is Tab =>
  value !== null && Object.hasOwn(TABS, value);

const STATUS_LABEL: Record<string, string> = {
  tracked: "Tracked",
  no_referral: "Not a referral",
  duplicate: "Already tracked",
  skipped: "Skipped",
  retrying: "Will retry",
  processing: "Sending",
  error: "Error",
};

const STATUS_TONE: Record<
  string,
  "success" | "neutral" | "warning" | "critical"
> = {
  tracked: "success",
  no_referral: "neutral",
  duplicate: "neutral",
  skipped: "neutral",
  retrying: "warning",
  processing: "neutral",
  error: "critical",
};

// Matches order ID, details text, event type, result label or HTTP status.
function searchWhere(q: string): Prisma.EventLogWhereInput {
  const needle = q.toLowerCase();
  const statuses = Object.entries(STATUS_LABEL)
    .filter(
      ([key, label]) =>
        label.toLowerCase().includes(needle) || key.includes(needle),
    )
    .map(([key]) => key);
  const types = ["sale", "refund"].filter((type) => type.startsWith(needle));
  return {
    OR: [
      { orderId: { contains: q } },
      { message: { contains: q, mode: "insensitive" } },
      ...(types.length ? [{ type: { in: types } }] : []),
      ...(statuses.length ? [{ status: { in: statuses } }] : []),
      ...(/^\d{3}$/.test(q) ? [{ httpStatus: Number(q) }] : []),
    ],
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const params = new URL(request.url).searchParams;
  const tab: Tab = isTab(params.get("status"))
    ? (params.get("status") as Tab)
    : "all";
  const q = (params.get("q") ?? "").trim();
  const where: Prisma.EventLogWhereInput = {
    shop: session.shop,
    ...(q ? searchWhere(q) : {}),
  };

  const grouped = await db.eventLog.groupBy({
    by: ["status"],
    where,
    _count: { _all: true },
  });
  const counts = Object.fromEntries(
    (Object.keys(TABS) as Tab[]).map((key) => {
      const statuses: readonly string[] | null = TABS[key].statuses;
      const total = grouped
        .filter((g) => !statuses || statuses.includes(g.status))
        .reduce((sum, g) => sum + g._count._all, 0);
      return [key, total];
    }),
  ) as Record<Tab, number>;

  const pageCount = Math.max(1, Math.ceil(counts[tab] / PAGE_SIZE));
  const page = Math.min(
    Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1),
    pageCount,
  );
  const statuses = TABS[tab].statuses;
  const hasEvents = q
    ? (await db.eventLog.count({ where: { shop: session.shop } })) > 0
    : counts.all > 0;

  const events = await db.eventLog.findMany({
    where: {
      ...where,
      ...(statuses ? { status: { in: [...statuses] } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });

  return {
    tab,
    q,
    page,
    pageCount,
    hasEvents,
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      orderId: e.orderId,
      status: e.status,
      httpStatus: e.httpStatus,
      message: e.message,
      at: e.updatedAt.toISOString(),
    })),
  };
};

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export default function Activity() {
  const { tab, q, page, pageCount, hasEvents, events } =
    useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const loading = useNavigation().state === "loading";
  const [query, setQuery] = useState(q);

  const show = (nextTab: Tab, nextPage = 1, nextQuery = q) => {
    const params = new URLSearchParams();
    if (nextTab !== "all") params.set("status", nextTab);
    if (nextQuery.trim()) params.set("q", nextQuery.trim());
    if (nextPage > 1) params.set("page", String(nextPage));
    setSearchParams(params, { replace: nextQuery !== q });
  };

  // Search after the user stops typing.
  useEffect(() => {
    if (query.trim() === q) return;
    const timer = setTimeout(() => show(tab, 1, query), 300);
    return () => clearTimeout(timer);
  }, [query, q, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!hasEvents) {
    return (
      <s-page heading="Activity">
        <s-section>
          <s-paragraph>
            Nothing yet. Paid orders and refunds will show up here.
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Activity">
      <s-section padding="none">
        <s-table
          paginate
          hasPreviousPage={page > 1}
          hasNextPage={page < pageCount}
          onPreviousPage={() => show(tab, page - 1)}
          onNextPage={() => show(tab, page + 1)}
          {...(loading ? { loading: true } : {})}
        >
          <s-grid
            slot="filters"
            gridTemplateColumns="max-content 1fr"
            gap="base"
            alignItems="center"
          >
            <s-grid
              gridTemplateColumns={`repeat(${Object.keys(TABS).length}, max-content)`}
              gap="small-200"
            >
              {(Object.keys(TABS) as Tab[]).map((key) => (
                <s-clickable
                  key={key}
                  borderRadius="large-200"
                  accessibilityLabel={`Show ${TABS[key].label.toLowerCase()} events`}
                  onClick={() => show(key, 1, query)}
                >
                  <s-badge
                    size="large"
                    tone={TABS[key].tone}
                    color={key === tab ? "strong" : "base"}
                  >
                    {TABS[key].label}
                  </s-badge>
                </s-clickable>
              ))}
            </s-grid>
            <s-search-field
              label="Search activity"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search by order, result, status code or details"
              value={query}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </s-grid>
          <s-table-header-row>
            <s-table-header>Date</s-table-header>
            <s-table-header>Event</s-table-header>
            <s-table-header>Order</s-table-header>
            <s-table-header>Result</s-table-header>
            <s-table-header>Details</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {events.map((event) => (
              <s-table-row key={event.id}>
                {/* Server and browser may format in different time zones. */}
                <s-table-cell>
                  <span suppressHydrationWarning>
                    {dateFormat.format(new Date(event.at))}
                  </span>
                </s-table-cell>
                <s-table-cell>
                  {event.type === "refund" ? "Refund" : "Sale"}
                </s-table-cell>
                <s-table-cell>
                  <s-link
                    href={`shopify://admin/orders/${event.orderId}`}
                    target="_top"
                  >
                    {event.orderId}
                  </s-link>
                </s-table-cell>
                <s-table-cell>
                  <s-badge tone={STATUS_TONE[event.status] ?? "neutral"}>
                    {STATUS_LABEL[event.status] ?? event.status}
                  </s-badge>
                </s-table-cell>
                <s-table-cell>
                  {[event.httpStatus, event.message]
                    .filter(Boolean)
                    .join(" · ")}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {events.length === 0 && (
          <s-box padding="base">
            <s-paragraph>
              {q ? "No events match your search." : "No events in this view."}
            </s-paragraph>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
