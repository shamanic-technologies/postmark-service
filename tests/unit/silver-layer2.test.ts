import { describe, it, expect } from "vitest";
import { recomputeLayer2 } from "../../src/lib/layer2";

const baseInputs = {
  errorCode: null as number | null,
  hasDelivery: false,
  hasBounce: false,
  hasOpen: false,
  hasClick: false,
  hasUnsubscribe: false,
  deliveredAt: null as Date | null,
};

describe("recomputeLayer2 — implication chain", () => {
  it("sending only (errorCode=0) → contacted+sent, nothing downstream", () => {
    const r = recomputeLayer2({ ...baseInputs, errorCode: 0 });
    expect(r).toEqual({
      contacted: true,
      sent: true,
      delivered: false,
      opened: false,
      clicked: false,
      bounced: false,
      unsubscribed: false,
      lastDeliveredAt: null,
      firstOpenedAt: null,
      firstClickedAt: null,
      firstBouncedAt: null,
      firstUnsubscribedAt: null,
    });
  });

  it("sending only (errorCode!=0) → contacted, NOT sent", () => {
    const r = recomputeLayer2({ ...baseInputs, errorCode: 422 });
    expect(r.contacted).toBe(true);
    expect(r.sent).toBe(false);
    expect(r.delivered).toBe(false);
  });

  it("delivery event → delivered, sent, contacted; not opened/clicked", () => {
    const deliveredAt = new Date("2026-05-20T12:00:00Z");
    const r = recomputeLayer2({ ...baseInputs, errorCode: 0, hasDelivery: true, deliveredAt });
    expect(r.delivered).toBe(true);
    expect(r.sent).toBe(true);
    expect(r.opened).toBe(false);
    expect(r.clicked).toBe(false);
    expect(r.lastDeliveredAt).toBe(deliveredAt);
  });

  it("bounce → bounced+sent, NOT delivered (even if delivery webhook present)", () => {
    const r = recomputeLayer2({ ...baseInputs, errorCode: 0, hasDelivery: true, hasBounce: true });
    expect(r.bounced).toBe(true);
    expect(r.sent).toBe(true);
    expect(r.delivered).toBe(false);
  });

  it("open → opened, delivered (implied), sent (implied)", () => {
    const r = recomputeLayer2({ ...baseInputs, hasOpen: true });
    expect(r.opened).toBe(true);
    expect(r.delivered).toBe(true);
    expect(r.sent).toBe(true);
    expect(r.clicked).toBe(false);
  });

  it("click → clicked, opened (implied), delivered (implied), sent (implied)", () => {
    const r = recomputeLayer2({ ...baseInputs, hasClick: true });
    expect(r.clicked).toBe(true);
    expect(r.opened).toBe(true);
    expect(r.delivered).toBe(true);
    expect(r.sent).toBe(true);
  });

  it("open alone does NOT imply clicked", () => {
    const r = recomputeLayer2({ ...baseInputs, hasOpen: true });
    expect(r.clicked).toBe(false);
  });

  it("unsubscribe → unsubscribed=true", () => {
    const r = recomputeLayer2({ ...baseInputs, hasUnsubscribe: true });
    expect(r.unsubscribed).toBe(true);
  });

  it("click + bounce → clicked, opened, sent, bounced, but NOT delivered", () => {
    const r = recomputeLayer2({ ...baseInputs, hasClick: true, hasBounce: true });
    expect(r.clicked).toBe(true);
    expect(r.opened).toBe(true);
    expect(r.sent).toBe(true);
    expect(r.bounced).toBe(true);
    expect(r.delivered).toBe(false);
  });
});

describe("recomputeLayer2 — first-occurrence timestamps", () => {
  const T1 = new Date("2026-05-20T10:00:00Z"); // open
  const T2 = new Date("2026-05-20T11:00:00Z"); // click (later)

  it("open@T1 + click@T2 → firstOpenedAt=T1, firstClickedAt=T2 (both non-null, ordered)", () => {
    const r = recomputeLayer2({
      ...baseInputs,
      hasOpen: true,
      hasClick: true,
      openFirstAt: T1,
      clickFirstAt: T2,
    });
    expect(r.firstOpenedAt).toEqual(T1);
    expect(r.firstClickedAt).toEqual(T2);
    expect(r.firstOpenedAt!.getTime()).toBeLessThan(r.firstClickedAt!.getTime());
  });

  it("click only (no open webhook) → firstOpenedAt implied = click time", () => {
    const r = recomputeLayer2({
      ...baseInputs,
      hasClick: true,
      clickFirstAt: T2,
    });
    expect(r.opened).toBe(true);
    expect(r.firstOpenedAt).toEqual(T2); // implied by click
    expect(r.firstClickedAt).toEqual(T2);
  });

  it("no engagement → all four first*At null", () => {
    const r = recomputeLayer2({ ...baseInputs, errorCode: 0 });
    expect(r.firstOpenedAt).toBeNull();
    expect(r.firstClickedAt).toBeNull();
    expect(r.firstBouncedAt).toBeNull();
    expect(r.firstUnsubscribedAt).toBeNull();
  });

  it("bounce@Tb → firstBouncedAt=Tb; unsubscribe@Tu → firstUnsubscribedAt=Tu", () => {
    const Tb = new Date("2026-05-20T12:00:00Z");
    const Tu = new Date("2026-05-20T13:00:00Z");
    const r = recomputeLayer2({
      ...baseInputs,
      hasBounce: true,
      bounceAt: Tb,
      hasUnsubscribe: true,
      unsubAt: Tu,
    });
    expect(r.firstBouncedAt).toEqual(Tb);
    expect(r.firstUnsubscribedAt).toEqual(Tu);
  });

  it("opened with no timestamp passed → firstOpenedAt null even though opened=true (graceful)", () => {
    const r = recomputeLayer2({ ...baseInputs, hasOpen: true });
    expect(r.opened).toBe(true);
    expect(r.firstOpenedAt).toBeNull();
  });
});
