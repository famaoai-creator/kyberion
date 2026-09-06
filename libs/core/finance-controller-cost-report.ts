import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';

const FINANCE_CONTROLLER_COST_REPORT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/finance-controller-cost-report.schema.json'
);

export type FinanceControllerCostReportSource = Record<string, unknown>;

/** Load one finance-controller cost report candidate through its schema boundary. */
export function loadFinanceControllerCostReportAtPath(
  filePath: string
): FinanceControllerCostReportSource | null {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeFilePath)) return null;
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[FINANCE_CONTROLLER_COST_REPORT] report must be a regular file: ${filePath}`);
  }
  return defineCatalog<FinanceControllerCostReportSource>({
    id: 'finance-controller-cost-report',
    path: safeFilePath,
    schema: FINANCE_CONTROLLER_COST_REPORT_SCHEMA_PATH,
  }).load();
}
