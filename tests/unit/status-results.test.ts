import { describe, it, expect } from "vitest";
import { buildStatusResults, serializeStatusResults, GlobalFlags, StatusRow } from "../../src/lib/status-results";

const BRAND = "b1";
const OTHER_BRAND = "b2";

function row(over: Partial<StatusRow>): StatusRow {
  return {
    messageId: Math.random().toString(36),
    toEmail: "a@x.com",
    campaignId: "c1",
    brandIds: [BRAND],
    contacted: true,
    sent: true,
    delivered: false,
    opened: false,
    clicked: false,
    bounced: false,
    unsubscribed: false,
    lastDeliveredAt: null,
    submittedAt: "2026-11-01T10:00:00.000Z",
    createdAt: "2026-11-01T10:00:00.000Z",
    firstOpenedAt: null,
    firstClickedAt: null,
    firstBouncedAt: null,
    firstUnsubscribedAt: null,
    ...over,
  };
}

describe("buildStatusResults (ORGS-STATUS-TIMEOUT-1107)", () => {
  it("keeps each address's scoped rows apart, answers every item in order, flags from the org-wide map", () => {
    // SQL already narrowed rows to the brand: b@x.com has only another brand's row, so none here.
    const scoped = [
      row({ toEmail: "a@x.com", campaignId: "c1", opened: true, firstOpenedAt: "2026-11-02T00:00:00.000Z" }),
      row({ toEmail: "a@x.com", campaignId: "c2", submittedAt: "2026-10-01T00:00:00.000Z" }),
    ];
    const flags = new Map<string, GlobalFlags>([["b@x.com", { bounced: true, unsubscribed: false }]]);
    const items = [{ email: "b@x.com" }, { email: "a@x.com" }, { email: "none@x.com" }];
    const out = buildStatusResults(items, scoped, flags, "brand");

    expect(out.map((r) => r.email)).toEqual(["b@x.com", "a@x.com", "none@x.com"]);

    expect(out[0].brand!.contacted).toBe(false);
    expect(out[0].byCampaign).toBeNull();
    expect(out[0].global.email.bounced).toBe(true);

    expect(out[1].brand!.sentCount).toBe(2);
    expect(out[1].brand!.opened).toBe(true);
    expect(out[1].brand!.firstContactedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(Object.keys(out[1].byCampaign!).sort()).toEqual(["c1", "c2"]);
    expect(out[1].global.email.bounced).toBe(false);

    expect(out[2].brand!.contacted).toBe(false);
    expect(out[2].global.email).toEqual({ bounced: false, unsubscribed: false });
  });

  it("campaign mode aggregates the campaign rows, global mode returns flags only", () => {
    const scoped = [row({ toEmail: "a@x.com", campaignId: "c1" })];
    const flags = new Map<string, GlobalFlags>([["a@x.com", { bounced: false, unsubscribed: true }]]);
    const camp = buildStatusResults([{ email: "a@x.com" }], scoped, flags, "campaign");
    expect(camp[0].campaign!.sentCount).toBe(1);
    expect(camp[0].campaign!.unsubscribed).toBe(false);
    expect(camp[0].global.email.unsubscribed).toBe(true);

    const glob = buildStatusResults([{ email: "a@x.com" }], [], flags, "global");
    expect(glob[0].brand).toBeNull();
    expect(glob[0].campaign).toBeNull();
    expect(glob[0].global.email.unsubscribed).toBe(true);
  });

  it("answers the biggest brand's shape (60k addresses) well inside the caller's 10s", () => {
    // Prod shape 2026-11-07: brand f4d73dab asks 60,668 lead addresses; 27,346 of them have
    // messages in its org. The old per-item filter took 15s at 10k items.
    const real = Array.from({ length: 27_346 }, (_, i) => `lead${i}@x.com`);
    const scoped: StatusRow[] = Array.from({ length: 2_000 }, (_, i) =>
      row({ toEmail: real[i % real.length], campaignId: `c${i % 7}` }),
    );
    const flags = new Map<string, GlobalFlags>(
      real.filter((_, i) => i % 20 === 0).map((e) => [e, { bounced: true, unsubscribed: false }]),
    );
    const items = [...real, ...Array.from({ length: 60_668 - real.length }, (_, i) => `miss${i}@x.com`)].map(
      (email) => ({ email }),
    );

    const t = Date.now();
    const out = buildStatusResults(items, scoped, flags, "brand");
    const ms = Date.now() - t;

    expect(out).toHaveLength(60_668);
    expect(ms).toBeLessThan(2_000);
  });

  it("serializeStatusResults is byte-equal to JSON.stringify of buildStatusResults, every mode and flag mix", () => {
    const scoped = [
      row({ toEmail: "a@x.com", campaignId: "c1", opened: true, firstOpenedAt: "2026-11-02T00:00:00.000Z" }),
      row({ toEmail: "a@x.com", campaignId: null, lastDeliveredAt: new Date("2026-11-03T00:00:00.000Z"), delivered: true }),
      row({ toEmail: "q\"uote@x.com", campaignId: "c2" }),
    ];
    const flags = new Map<string, GlobalFlags>([
      ["a@x.com", { bounced: true, unsubscribed: false }],
      ["b@x.com", { bounced: false, unsubscribed: true }],
      ["c@x.com", { bounced: true, unsubscribed: true }],
    ]);
    const items = ["b@x.com", "a@x.com", "c@x.com", "q\"uote@x.com", "none@x.com", "a@x.com"].map((email) => ({ email }));
    for (const mode of ["brand", "campaign", "global"] as const) {
      const rows = mode === "global" ? [] : scoped;
      expect(serializeStatusResults(items, rows, flags, mode)).toBe(
        JSON.stringify({ results: buildStatusResults(items, rows, flags, mode) }),
      );
    }
    expect(serializeStatusResults([{ email: "a@x.com" }], [], new Map(), "brand")).toBe(
      JSON.stringify({ results: buildStatusResults([{ email: "a@x.com" }], [], new Map(), "brand") }),
    );
  });

  it("serializes the biggest brand's ask (60k addresses) in well under a second", () => {
    const items = Array.from({ length: 60_668 }, (_, i) => ({ email: `lead${i}@x.com` }));
    const scoped = Array.from({ length: 20 }, (_, i) => row({ toEmail: `lead${i * 1000}@x.com` }));
    const flags = new Map<string, GlobalFlags>([["lead7@x.com", { bounced: true, unsubscribed: false }]]);
    const t = Date.now();
    const body = serializeStatusResults(items, scoped, flags, "brand");
    expect(Date.now() - t).toBeLessThan(1_000);
    expect(JSON.parse(body).results).toHaveLength(60_668);
  });
});
