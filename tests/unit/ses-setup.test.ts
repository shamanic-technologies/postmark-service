import { describe, it, expect } from "vitest";
import { planSuppressionCarry, planMarketingCarry } from "../../src/lib/ses-setup";

describe("planSuppressionCarry — same reach on SES as on Postmark", () => {
  const plan = planSuppressionCarry([
    {
      stream: "broadcast",
      type: "Broadcasts",
      suppressions: [
        { EmailAddress: "Unsub@X.com", SuppressionReason: "ManualSuppression", Origin: "Recipient" },
        { EmailAddress: "dead@x.com", SuppressionReason: "HardBounce", Origin: "Recipient" },
        { EmailAddress: "spam@x.com", SuppressionReason: "SpamComplaint", Origin: "Recipient" },
      ],
    },
    {
      stream: "outbound",
      type: "Transactional",
      suppressions: [
        { EmailAddress: "gone@y.com", SuppressionReason: "HardBounce", Origin: "Recipient" },
        { EmailAddress: "stop@y.com", SuppressionReason: "ManualSuppression", Origin: "Customer" },
      ],
    },
  ]);

  it("broadcast-stream blocks → opted out of the product-mail contact list (sign-up codes still go, as on Postmark)", () => {
    expect(plan.contactOptOuts).toEqual(["dead@x.com", "spam@x.com", "unsub@x.com"]);
  });

  it("transactional-stream blocks → SES account suppression, BOUNCE or COMPLAINT", () => {
    expect(plan.accountSuppressions).toEqual([
      { email: "gone@y.com", reason: "BOUNCE" },
      { email: "stop@y.com", reason: "COMPLAINT" },
    ]);
  });
});

describe("planMarketingCarry — the newsletter keeps every Postmark broadcast opt-out", () => {
  const plan = planMarketingCarry([
    {
      stream: "broadcast",
      type: "Broadcasts",
      suppressions: [
        { EmailAddress: "Unsub@X.com", SuppressionReason: "ManualSuppression", Origin: "Recipient" },
        { EmailAddress: "dead@x.com", SuppressionReason: "HardBounce", Origin: "Recipient" },
        { EmailAddress: "spam@x.com", SuppressionReason: "SpamComplaint", Origin: "Recipient" },
      ],
    },
    { stream: "outbound", type: "Transactional", suppressions: [{ EmailAddress: "code@y.com", SuppressionReason: "HardBounce", Origin: "Recipient" }] },
  ]);
  it("every broadcast suppression = opted out of the newsletter contact list", () => {
    expect(plan.contactOptOuts).toEqual(["dead@x.com", "spam@x.com", "unsub@x.com"]);
  });
  it("hard bounces and complaints also on the marketing account's suppression list; the transactional stream is not the newsletter's", () => {
    expect(plan.accountSuppressions).toEqual([
      { email: "dead@x.com", reason: "BOUNCE" },
      { email: "spam@x.com", reason: "COMPLAINT" },
    ]);
  });
});
