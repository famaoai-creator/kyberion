import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';

const FINANCE_CONTROLLER_COST_REPORT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/finance-controller-cost-report.schema.json'
);

export type FinanceControllerCostReportSource = Record<string, unknown>;

export interface FinanceControllerCostCoverage {
  costComplete?: boolean;
  unknownCostCalls?: number;
  includedCalls?: number;
  referenceCostUsd?: number;
  referenceCostCalls?: number;
}

/** Additive accounting metadata; absent fields retain legacy report compatibility. */
export function financeControllerCostCoverage(
  ...envelopes: FinanceControllerCostReportSource[]
): FinanceControllerCostCoverage {
  for (const envelope of envelopes) {
    for (const key of [
      'reference_usd',
      'reference_cost_calls',
      'included_calls',
      'unknown_cost_calls',
      'actual_cost_calls',
      'estimated_cost_calls',
    ]) {
      const value = envelope[key];
      if (
        value !== undefined &&
        (typeof value !== 'number' ||
          !Number.isFinite(value) ||
          value < 0 ||
          (key !== 'reference_usd' && !Number.isInteger(value)))
      ) {
        throw new Error(`[FINANCE_CONTROLLER_COST_REPORT] Invalid accounting field: ${key}`);
      }
    }
    if (envelope.cost_complete !== undefined && typeof envelope.cost_complete !== 'boolean')
      throw new Error('[FINANCE_CONTROLLER_COST_REPORT] Invalid accounting field: cost_complete');
    if (envelope.cost_complete === true && Number(envelope.unknown_cost_calls ?? 0) > 0)
      throw new Error('[FINANCE_CONTROLLER_COST_REPORT] Unknown costs cannot be complete');
  }
  const first = (field: string) => {
    const values = envelopes
      .map((envelope) => envelope[field])
      .filter((value) => value !== undefined);
    if (new Set(values).size > 1)
      throw new Error(`[FINANCE_CONTROLLER_COST_REPORT] Conflicting accounting field: ${field}`);
    return values[0];
  };
  const costComplete = first('cost_complete') as boolean | undefined;
  const unknownCostCalls = first('unknown_cost_calls') as number | undefined;
  const includedCalls = first('included_calls') as number | undefined;
  const referenceCostUsd = first('reference_usd') as number | undefined;
  const referenceCostCalls = first('reference_cost_calls') as number | undefined;
  return {
    ...(costComplete !== undefined || (unknownCostCalls ?? 0) > 0
      ? { costComplete: costComplete !== false && (unknownCostCalls ?? 0) === 0 }
      : {}),
    ...(unknownCostCalls !== undefined ? { unknownCostCalls } : {}),
    ...(includedCalls !== undefined ? { includedCalls } : {}),
    ...(referenceCostUsd !== undefined ? { referenceCostUsd } : {}),
    ...(referenceCostCalls !== undefined ? { referenceCostCalls } : {}),
  };
}

/** Load one finance-controller cost report candidate through its schema boundary. */
export function loadFinanceControllerCostReportAtPath(
  filePath: string
): FinanceControllerCostReportSource | null {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeFilePath)) return null;
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[FINANCE_CONTROLLER_COST_REPORT] report must be a regular file: ${filePath}`);
  }
  const report = defineCatalog<FinanceControllerCostReportSource>({
    id: 'finance-controller-cost-report',
    path: safeFilePath,
    schema: FINANCE_CONTROLLER_COST_REPORT_SCHEMA_PATH,
  }).load();
  financeControllerCostCoverage(
    report,
    ...['totals', 'usage', 'metrics', 'summary'].flatMap((field) => {
      const value = report[field];
      return value && typeof value === 'object' && !Array.isArray(value)
        ? [value as FinanceControllerCostReportSource]
        : [];
    })
  );
  return report;
}
