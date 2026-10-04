import { describe, it, expect } from "vitest";
import {
  PLATFORM_LIFECYCLE_TAGS,
  isPlatformLifecycleTag,
} from "../../src/lib/lifecycle-tags";

describe("platform lifecycle tags", () => {
  // billing-service sends every one of these; transactional-email-service forwards the
  // eventType verbatim as the tag. Every one of them reports on the org's billing
  // state, so billing the org for the send lets the report re-trigger the charge
  // path it reports on — the 2026-08-29 authorization storm.
  const BILLING_NOTIFICATIONS = [
    "credits-reload-failed",
    "credit-depleted",
    "credit-depleted-followup-3d",
    "credit-depleted-followup-10d",
    "credit-depleted-blocked",
    "credit-depleted-followup-3d-blocked",
    "credit-depleted-followup-10d-blocked",
    // The debt pair is sent BECAUSE the org cannot pay: org-billed, its balance
    // refused both (prod 2026-10-01, 402 Insufficient credits).
    "credit-debt-card-required",
    "unpaid_debt_uncollectable",
    "credit-card-unusable",
    "subscription-credits-used",
    "subscription-monthly-update",
    "referral-reward-opened",
    "referral-credits-granted",
    "brand_daily_budget_changed",
  ];

  // Delivered to our own staff list, never to the customer: never the customer's spend.
  const STAFF_ALERTS = [
    "payment_method_removed",
    "staff_daily_digest",
    "provider_credits_exhausted",
    "campaign_failing",
  ];

  const ACCOUNT_LIFECYCLE = [
    "welcome",
    "signup_notification",
    "signin_notification",
    "user_active",
    "waitlist",
  ];

  it.each(BILLING_NOTIFICATIONS)("exempts the billing notification %s", (tag) => {
    expect(isPlatformLifecycleTag(tag)).toBe(true);
  });

  it.each(STAFF_ALERTS)("exempts the staff alert %s", (tag) => {
    expect(isPlatformLifecycleTag(tag)).toBe(true);
  });

  it.each(ACCOUNT_LIFECYCLE)("exempts the account lifecycle mail %s", (tag) => {
    expect(isPlatformLifecycleTag(tag)).toBe(true);
  });

  it("does not exempt an ordinary org email", () => {
    expect(isPlatformLifecycleTag("campaign_created")).toBe(false);
    expect(isPlatformLifecycleTag("cold-outreach")).toBe(false);
  });

  it("treats an absent tag as billable", () => {
    expect(isPlatformLifecycleTag(null)).toBe(false);
    expect(isPlatformLifecycleTag(undefined)).toBe(false);
  });

  it("exempts nothing beyond the declared set", () => {
    expect([...PLATFORM_LIFECYCLE_TAGS].sort()).toEqual(
      [...ACCOUNT_LIFECYCLE, ...BILLING_NOTIFICATIONS, ...STAFF_ALERTS].sort()
    );
  });
});
