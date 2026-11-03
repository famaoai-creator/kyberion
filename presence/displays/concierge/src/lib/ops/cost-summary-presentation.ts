import type { CostCoverageSummary } from './su-surface-data';
import { uxText, type SupportedLocale } from './ux-vocabulary';

/** A recorded subtotal of zero is not evidence that an unmetered call was free. */
export function costAmountLabel(
  amount: number | undefined,
  coverage: CostCoverageSummary | undefined,
  locale: SupportedLocale
): string {
  if (amount === undefined) return '-';
  if (amount === 0) {
    const pricedCalls = (coverage?.actualCostCalls ?? 0) + (coverage?.estimatedCostCalls ?? 0);
    if (coverage?.costComplete !== true && pricedCalls === 0)
      return uxText('chronos_cost_unknown', locale);
    if (coverage?.includedCalls && pricedCalls === 0)
      return uxText('chronos_cost_included', locale);
    if (pricedCalls === 0) return uxText('chronos_cost_unknown', locale);
  }
  return `$${amount.toFixed(3)}`;
}

export function referenceAmountLabel(
  coverage: CostCoverageSummary | undefined,
  locale: SupportedLocale
): string {
  return coverage?.referenceUsd !== undefined &&
    ((coverage.referenceCostCalls ?? 0) > 0 || coverage.referenceUsd > 0)
    ? `$${coverage.referenceUsd.toFixed(3)}`
    : uxText('chronos_cost_unknown', locale);
}
