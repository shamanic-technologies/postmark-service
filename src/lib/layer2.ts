/**
 * Pure Layer 2 status computation. No DB, no I/O. Easily unit-testable in isolation
 * so tests don't require POSTMARK_SERVICE_DATABASE_URL.
 */

export interface Layer2Inputs {
  errorCode: number | null;
  hasDelivery: boolean;
  hasBounce: boolean;
  hasOpen: boolean;
  hasClick: boolean;
  hasUnsubscribe: boolean;
  deliveredAt: Date | null;
}

export interface Layer2Result {
  contacted: boolean;
  sent: boolean;
  delivered: boolean;
  opened: boolean;
  clicked: boolean;
  bounced: boolean;
  unsubscribed: boolean;
  lastDeliveredAt: Date | null;
}

/**
 * Compute Layer 2 status from raw event presence flags.
 * Implication chain: contacted → sent → delivered → opened → clicked.
 *   - click forces opened, delivered (unless bounced), sent
 *   - open forces delivered (unless bounced), sent
 *   - bounce forces sent=true, delivered=false (even if a delivery webhook exists)
 *   - errorCode=0 alone gives sent=true
 *   - sending row existing gives contacted=true
 */
export function recomputeLayer2(inputs: Layer2Inputs): Layer2Result {
  const clicked = inputs.hasClick;
  const opened = inputs.hasOpen || clicked;
  const delivered = (inputs.hasDelivery || opened) && !inputs.hasBounce;
  const sent =
    inputs.errorCode === 0 ||
    inputs.hasDelivery ||
    opened ||
    clicked ||
    inputs.hasBounce;
  const contacted = true;

  return {
    contacted,
    sent,
    delivered,
    opened,
    clicked,
    bounced: inputs.hasBounce,
    unsubscribed: inputs.hasUnsubscribe,
    lastDeliveredAt: inputs.deliveredAt,
  };
}
