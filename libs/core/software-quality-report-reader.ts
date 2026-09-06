import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeLstat } from './secure-io.js';

export interface PersistedSoftwareQualityReport {
  version: string;
  report_id: string;
  project_id: string;
  subject_ref: string;
  generated_at: string;
  gate_status: {
    dor: 'pass' | 'fail' | 'waived' | 'insufficient_evidence';
    acceptance_criteria: 'pass' | 'fail' | 'waived' | 'insufficient_evidence';
    dod: 'pass' | 'fail' | 'waived' | 'insufficient_evidence';
  };
  coverage: Record<string, number>;
  execution: Record<string, number>;
  defects: Record<string, number>;
  residual_risks: string[];
  waiver_refs: string[];
  recommendation: 'go' | 'conditional_go' | 'no_go' | 'insufficient_evidence';
  recommendation_reasons?: string[];
  evidence_refs: string[];
  accountable_human_id: string;
  human_decision: 'pending' | 'approved' | 'rejected';
  human_decided_at?: string;
}

const SOFTWARE_QUALITY_REPORT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/software-quality-report.schema.json'
);

/** Load a persisted quality report through the shared schema and path boundary. */
export function loadSoftwareQualityReportAtPath(filePath: string): PersistedSoftwareQualityReport {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeLstat(safePath).isFile()) {
    throw new Error(`[SOFTWARE_QUALITY_REPORT] report must be a regular file: ${filePath}`);
  }
  return defineCatalog<PersistedSoftwareQualityReport>({
    id: 'software-quality-report',
    path: safePath,
    schema: SOFTWARE_QUALITY_REPORT_SCHEMA_PATH,
  }).load();
}
