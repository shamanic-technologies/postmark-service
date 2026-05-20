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
