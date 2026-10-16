import { describe, it, expect } from "vitest";
import { creditRefusalBody } from "../../src/lib/credit-refusal";

const cap = {
  salesFunnelId: "sf-1",
  salesFunnelCampaignId: "sfc-1",
  amountCents: 5000,
  period: "monthly",
  consumedCents: 5000,
  reservedCents: 0,
};

describe("creditRefusalBody", () => {
  it("keeps the historical body byte-identical on a balance shortfall (no reason)", () => {
    expect(
      creditRefusalBody({ sufficient: false, balance_cents: 0, required_cents: 1 })
    ).toEqual({ error: "Insufficient credits", balance_cents: 0, required_cents: 1 });
  });

  it("names a reached sales funnel max budget and passes reason + cap verbatim", () => {
    expect(
      creditRefusalBody({
        sufficient: false,
        balance_cents: 9000,
        required_cents: 1,
        reason: "sales_funnel_max_budget_reached",
        sales_funnel_cap: cap,
      })
    ).toEqual({
      error: "Sales funnel max budget reached",
      balance_cents: 9000,
      required_cents: 1,
      reason: "sales_funnel_max_budget_reached",
      sales_funnel_cap: cap,
    });
  });

  it("names an unreadable sales funnel max budget", () => {
    const body = creditRefusalBody({
      sufficient: false,
      balance_cents: 9000,
      required_cents: 1,
      reason: "sales_funnel_max_budget_unreadable",
    });
    expect(body.error).toBe("Sales funnel max budget unreadable");
    expect(body.reason).toBe("sales_funnel_max_budget_unreadable");
    expect(body).not.toHaveProperty("sales_funnel_cap");
  });
});
