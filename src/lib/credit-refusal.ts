import type { AuthorizeResult } from "./billing-client";

/**
 * Error wording per billing refusal reason, identical to chat-service (the
 * fleet's reference): a sales funnel max budget refusal is NOT a balance
 * problem, adding credit cannot help, raising the campaign's max budget can.
 */
const SALES_FUNNEL_REFUSAL_ERROR: Record<string, string> = {
  sales_funnel_max_budget_reached: "Sales funnel max budget reached",
  sales_funnel_max_budget_unreadable: "Sales funnel max budget unreadable",
};

/**
 * The 402 body for a refused authorize. A real balance shortfall (no
 * `reason`) keeps the historical body byte-identical; a sales funnel max
 * budget refusal names its cause and passes billing's `reason` +
 * `sales_funnel_cap` through verbatim.
 */
export function creditRefusalBody(auth: AuthorizeResult): Record<string, unknown> {
  const body: Record<string, unknown> = {
    error: auth.reason
      ? (SALES_FUNNEL_REFUSAL_ERROR[auth.reason] ?? "Sales funnel max budget reached")
      : "Insufficient credits",
    balance_cents: auth.balance_cents,
    required_cents: auth.required_cents,
  };
  if (auth.reason) {
    body.reason = auth.reason;
    if (auth.sales_funnel_cap) body.sales_funnel_cap = auth.sales_funnel_cap;
  }
  return body;
}
