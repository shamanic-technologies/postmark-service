/**
 * POST /orgs/status aggregation, kept pure so it is unit-testable.
 *
 * ORGS-STATUS-TIMEOUT-1107: the route used to run `rows.filter(r => r.toEmail === item.email)`
 * once per requested item, i.e. O(items × rows). Our biggest brand asks ~60k addresses at once
 * against ~90k message rows of its org: 10k items already took 15s on prod (caller cap 10s),
 * the event loop was blocked for the whole read, so concurrent asks (features-service boot)
 * queued behind each other and even the pg pool timed out. Now SQL returns only the rows of
 * the asked scope (20 for that brand, not 90k) plus the few addresses carrying an org-wide
 * bounce/unsubscribe flag, and rows are indexed by address once: O(items + scoped rows).
 */

export type StatusMode = "brand" | "campaign" | "global";

export interface StatusRow {
  messageId: string;
  toEmail: string;
  campaignId: string | null;
  brandIds: string[] | null;
  contacted: boolean;
  sent: boolean;
  delivered: boolean;
  opened: boolean;
  clicked: boolean;
  bounced: boolean;
  unsubscribed: boolean;
  lastDeliveredAt: Date | string | null;
  submittedAt: Date | string | null;
  createdAt: Date | string | null;
  firstOpenedAt: Date | string | null;
  firstClickedAt: Date | string | null;
  firstBouncedAt: Date | string | null;
  firstUnsubscribedAt: Date | string | null;
}

const toDate = (v: Date | string | null): Date | null =>
  v == null ? null : v instanceof Date ? v : new Date(v);
const earlier = (acc: Date | null, v: Date | null): Date | null =>
  v == null ? acc : acc == null || v < acc ? v : acc;

export function aggregateScope(group: StatusRow[]) {
  let contacted = false;
  let sent = false;
  let delivered = false;
  let opened = false;
  let clicked = false;
  let bounced = false;
  let unsubscribed = false;
  let lastDeliveredAt: Date | null = null;
  // Send-event COUNT: one postmarkMessages row = one transactional message,
  // so the number of emails actually sent to this recipient in the scope is
  // the count of rows whose `sent` is true. Brand scope groups all of the
  // brand's campaign rows, so its count is the SUM across campaigns for free.
  let sentCount = 0;

  // First-occurrence (MIN) accumulators. firstContacted/Sent/Delivered are
  // derived from existing columns (submitted_at / created_at / last_delivered_at);
  // firstOpened/Clicked/Bounced/Unsub are stored on the silver row.
  let firstContactedAt: Date | null = null;
  let firstSentAt: Date | null = null;
  let firstDeliveredAt: Date | null = null;
  let firstOpenedAt: Date | null = null;
  let firstClickedAt: Date | null = null;
  let firstBouncedAt: Date | null = null;
  let firstUnsubscribedAt: Date | null = null;

  for (const r of group) {
    if (r.contacted) contacted = true;
    if (r.sent) sent = true;
    if (r.delivered) delivered = true;
    if (r.opened) opened = true;
    if (r.clicked) clicked = true;
    if (r.bounced) bounced = true;
    if (r.unsubscribed) unsubscribed = true;
    if (r.sent) sentCount++;
    if (r.lastDeliveredAt) {
      const dt = toDate(r.lastDeliveredAt)!;
      if (!lastDeliveredAt || dt > lastDeliveredAt) lastDeliveredAt = dt;
    }

    // Per-message milestone timestamps, then MIN across the scope.
    const rowContactedAt = toDate(r.submittedAt) ?? toDate(r.createdAt);
    const rowOpenedAt = toDate(r.firstOpenedAt);
    const rowDeliveredAt = r.delivered ? toDate(r.lastDeliveredAt) ?? rowOpenedAt : null;
    firstContactedAt = earlier(firstContactedAt, rowContactedAt);
    firstSentAt = earlier(firstSentAt, r.sent ? rowContactedAt : null);
    firstDeliveredAt = earlier(firstDeliveredAt, rowDeliveredAt);
    firstOpenedAt = earlier(firstOpenedAt, rowOpenedAt);
    firstClickedAt = earlier(firstClickedAt, toDate(r.firstClickedAt));
    firstBouncedAt = earlier(firstBouncedAt, toDate(r.firstBouncedAt));
    firstUnsubscribedAt = earlier(firstUnsubscribedAt, toDate(r.firstUnsubscribedAt));
  }

  return {
    contacted,
    sent,
    delivered,
    opened,
    clicked,
    replied: false,
    replyClassification: null as string | null,
    bounced,
    unsubscribed,
    cancelled: false,
    sentCount,
    lastDeliveredAt: lastDeliveredAt?.toISOString() ?? null,
    firstContactedAt: firstContactedAt?.toISOString() ?? null,
    firstSentAt: firstSentAt?.toISOString() ?? null,
    firstDeliveredAt: firstDeliveredAt?.toISOString() ?? null,
    firstOpenedAt: firstOpenedAt?.toISOString() ?? null,
    firstClickedAt: firstClickedAt?.toISOString() ?? null,
    firstRepliedAt: null as string | null,
    firstBouncedAt: firstBouncedAt?.toISOString() ?? null,
    firstUnsubscribedAt: firstUnsubscribedAt?.toISOString() ?? null,
  };
}

export interface GlobalFlags {
  bounced: boolean;
  unsubscribed: boolean;
}

const NO_FLAGS: GlobalFlags = { bounced: false, unsubscribed: false };
const NO_ROWS: StatusRow[] = [];

/**
 * @param scopedRows rows already narrowed IN SQL to the asked scope: the brand's rows
 *   (brand mode), the campaign's rows (campaign mode), none (global mode).
 * @param flaggedEmails per-address org-wide flags, only for addresses carrying at least
 *   one of them (an absent address is bounced=false, unsubscribed=false).
 */
export function buildStatusResults(
  items: { email: string }[],
  scopedRows: StatusRow[],
  flaggedEmails: Map<string, GlobalFlags>,
  mode: StatusMode,
) {
  // One pass over the rows: address -> its rows (exact-match key, as before).
  const rowsByEmail = new Map<string, StatusRow[]>();
  for (const r of scopedRows) {
    let g = rowsByEmail.get(r.toEmail);
    if (!g) {
      g = [];
      rowsByEmail.set(r.toEmail, g);
    }
    g.push(r);
  }

  return items.map((item) => {
    const emailRows = rowsByEmail.get(item.email) ?? NO_ROWS;
    const flags = flaggedEmails.get(item.email) ?? NO_FLAGS;
    const global = { email: { bounced: flags.bounced, unsubscribed: flags.unsubscribed } };

    if (mode === "campaign") {
      return {
        email: item.email,
        byCampaign: null,
        brand: null,
        campaign: aggregateScope(emailRows),
        global,
      };
    }

    if (mode === "brand") {
      const campaignGroups = new Map<string, StatusRow[]>();
      for (const r of emailRows) {
        if (r.campaignId) {
          let g = campaignGroups.get(r.campaignId);
          if (!g) {
            g = [];
            campaignGroups.set(r.campaignId, g);
          }
          g.push(r);
        }
      }

      const byCampaign: Record<string, ReturnType<typeof aggregateScope>> = {};
      for (const [cId, group] of campaignGroups) {
        byCampaign[cId] = aggregateScope(group);
      }

      return {
        email: item.email,
        byCampaign: Object.keys(byCampaign).length > 0 ? byCampaign : null,
        brand: aggregateScope(emailRows),
        campaign: null,
        global,
      };
    }

    return {
      email: item.email,
      byCampaign: null,
      brand: null,
      campaign: null,
      global,
    };
  });
}

/**
 * The JSON body `{ results }` of POST /orgs/status, byte-equal to
 * `JSON.stringify({ results: buildStatusResults(...) })`.
 *
 * ORGS-STATUS-TIMEOUT-1107: most addresses of a big ask carry no row in the scope (60k asked,
 * 20 brand rows for our biggest brand), and building then stringifying 60k identical empty
 * objects cost ~0.45s of event loop per ask, ~32 MB each. An address with no scoped row is
 * written from a fragment computed once per ask; only addresses with rows go through
 * buildStatusResults.
 */
export function serializeStatusResults(
  items: { email: string }[],
  scopedRows: StatusRow[],
  flaggedEmails: Map<string, GlobalFlags>,
  mode: StatusMode,
): string {
  const rowsByEmail = new Map<string, StatusRow[]>();
  for (const r of scopedRows) {
    let g = rowsByEmail.get(r.toEmail);
    if (!g) {
      g = [];
      rowsByEmail.set(r.toEmail, g);
    }
    g.push(r);
  }

  // Tail of an empty item's object (everything after "email"), one per flag combination.
  const emptyTails = new Map<string, string>();
  const emptyTail = (flags: GlobalFlags): string => {
    const key = `${flags.bounced}|${flags.unsubscribed}`;
    let tail = emptyTails.get(key);
    if (tail === undefined) {
      const [probe] = buildStatusResults([{ email: "" }], NO_ROWS, new Map([["", flags]]), mode);
      const full = JSON.stringify(probe);
      const head = `{"email":""`;
      if (!full.startsWith(head)) throw new Error("status result no longer opens on its email field");
      tail = full.slice(head.length);
      emptyTails.set(key, tail);
    }
    return tail;
  };

  const parts: string[] = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const email = items[i].email;
    const emailRows = rowsByEmail.get(email);
    if (emailRows) {
      parts[i] = JSON.stringify(buildStatusResults([items[i]], emailRows, flaggedEmails, mode)[0]);
    } else {
      parts[i] = `{"email":${JSON.stringify(email)}${emptyTail(flaggedEmails.get(email) ?? NO_FLAGS)}`;
    }
  }
  return `{"results":[${parts.join(",")}]}`;
}
