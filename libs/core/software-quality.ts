export type QualityCheckStatus = 'pending' | 'passed' | 'failed' | 'waived';

export interface QualityCheck {
  check_id: string;
  description: string;
  status: QualityCheckStatus;
  evidence_refs?: string[];
  owner_id?: string;
  blocking?: boolean;
}

export interface AcceptanceCriterion {
  criterion_id: string;
  description: string;
  requirement_refs: string[];
  expected_result: string;
  status: QualityCheckStatus;
  evidence_refs?: string[];
}

export interface QualityWaiver {
  waiver_id: string;
  check_refs: string[];
  reason: string;
  accountable_human_id: string;
  expires_at: string;
  compensating_controls: string[];
  residual_risk: string;
}

export interface SoftwareQualityContract {
  version: string;
  project_id: string;
  accountable_human_id: string;
  dor: QualityCheck[];
  acceptance_criteria: AcceptanceCriterion[];
  dod: QualityCheck[];
  must_have_requirement_ids?: string[];
  waivers?: QualityWaiver[];
}

export interface TestInventoryItem {
  item_id: string;
  title: string;
  viewpoint_ids: string[];
  requirement_refs?: string[];
  acceptance_criteria_refs?: string[];
  risk_refs?: string[];
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  expected_result: string;
  execution_mode: 'safe_auto' | 'approval_required' | 'manual_only' | 'prohibited';
  omission_reason?: string;
  automation?: {
    actuator: 'code' | 'system' | 'browser' | 'network';
    op: string;
    params: Record<string, unknown>;
  };
}

export interface TestInventory {
  version: string;
  project_id: string;
  items: TestInventoryItem[];
}

export interface QualityEvaluation {
  passed: boolean;
  reasons: string[];
}

export interface TestExecutionResult {
  item_id: string;
  status: 'passed' | 'failed' | 'error' | 'blocked' | 'skipped';
  evidence_refs: string[];
  observed_result?: string;
}

export interface TestExecutionRecord {
  run_id: string;
  subject_ref: string;
  results: TestExecutionResult[];
}

export interface DefectCandidate {
  defect_id: string;
  source_test_refs: string[];
  title: string;
  status: 'candidate';
  severity: 'blocker' | 'critical' | 'major' | 'minor' | 'trivial';
  expected_result: string;
  observed_result: string;
  evidence_refs: string[];
}

export interface SoftwareQualityReportSummary {
  gate_status: {
    dor: 'pass' | 'fail' | 'insufficient_evidence';
    acceptance_criteria: 'pass' | 'fail' | 'insufficient_evidence';
    dod: 'pass' | 'fail' | 'insufficient_evidence';
  };
  coverage: Record<string, number>;
  execution: Record<string, number>;
  defects: Record<string, number>;
  residual_risks: string[];
  recommendation: 'go' | 'conditional_go' | 'no_go' | 'insufficient_evidence';
  recommendation_reasons: string[];
  evidence_refs: string[];
  accountable_human_id: string;
  human_decision: 'pending';
}

const AMBIGUOUS_ACCEPTANCE_PATTERNS = [
  /適切/u,
  /問題なく/u,
  /必要に応じ/u,
  /できるだけ/u,
  /十分/u,
  /properly/iu,
  /as needed/iu,
  /user[- ]friendly/iu,
];

function activeWaiverFor(
  contract: SoftwareQualityContract,
  checkId: string,
  now: Date
): QualityWaiver | undefined {
  return contract.waivers?.find((waiver) => {
    const expiresAt = Date.parse(waiver.expires_at);
    return (
      waiver.check_refs.includes(checkId) &&
      waiver.accountable_human_id.trim().length > 0 &&
      waiver.compensating_controls.length > 0 &&
      waiver.residual_risk.trim().length > 0 &&
      Number.isFinite(expiresAt) &&
      expiresAt > now.getTime()
    );
  });
}

function evaluateChecks(
  checks: QualityCheck[],
  contract: SoftwareQualityContract,
  now: Date,
  label: string
): QualityEvaluation {
  const reasons: string[] = [];
  if (checks.length === 0) reasons.push(`${label} has no checks.`);
  for (const check of checks) {
    if (!check.check_id.trim() || !check.description.trim()) {
      reasons.push(`${label} contains a check without an id or description.`);
      continue;
    }
    if (check.status === 'passed' && (check.evidence_refs?.length ?? 0) === 0) {
      reasons.push(`${label} ${check.check_id} passed without evidence.`);
    }
    if (check.status !== 'passed' && !activeWaiverFor(contract, check.check_id, now)) {
      reasons.push(`${label} ${check.check_id} is ${check.status} without an active waiver.`);
    }
  }
  return { passed: reasons.length === 0, reasons };
}

export function evaluateQualityContract(contract: SoftwareQualityContract): QualityEvaluation {
  const reasons: string[] = [];
  if (!contract.version?.trim()) reasons.push('Quality contract version is required.');
  if (!contract.project_id?.trim()) reasons.push('Quality contract project_id is required.');
  if (!contract.accountable_human_id?.trim()) {
    reasons.push('An accountable human is required.');
  }
  if (contract.acceptance_criteria.length === 0) {
    reasons.push('At least one acceptance criterion is required.');
  }
  const ids = new Set<string>();
  for (const criterion of contract.acceptance_criteria) {
    if (!criterion.criterion_id.trim() || ids.has(criterion.criterion_id)) {
      reasons.push(
        `Acceptance criterion id is missing or duplicated: ${criterion.criterion_id || '<empty>'}.`
      );
    }
    ids.add(criterion.criterion_id);
    if (criterion.requirement_refs.length === 0) {
      reasons.push(`Acceptance criterion ${criterion.criterion_id} has no requirement reference.`);
    }
    if (!criterion.expected_result.trim()) {
      reasons.push(
        `Acceptance criterion ${criterion.criterion_id} has no observable expected result.`
      );
    }
    if (AMBIGUOUS_ACCEPTANCE_PATTERNS.some((pattern) => pattern.test(criterion.description))) {
      reasons.push(`Acceptance criterion ${criterion.criterion_id} uses ambiguous language.`);
    }
  }
  return { passed: reasons.length === 0, reasons };
}

export function evaluateDefinitionOfReady(
  contract: SoftwareQualityContract,
  now = new Date()
): QualityEvaluation {
  const contractResult = evaluateQualityContract(contract);
  const dorResult = evaluateChecks(contract.dor, contract, now, 'DoR');
  return {
    passed: contractResult.passed && dorResult.passed,
    reasons: [...contractResult.reasons, ...dorResult.reasons],
  };
}

export function evaluateAcceptanceCriteria(
  contract: SoftwareQualityContract,
  now = new Date()
): QualityEvaluation {
  const reasons: string[] = [];
  for (const criterion of contract.acceptance_criteria) {
    if (criterion.status === 'passed' && (criterion.evidence_refs?.length ?? 0) === 0) {
      reasons.push(`Acceptance criterion ${criterion.criterion_id} passed without evidence.`);
    }
    if (criterion.status !== 'passed' && !activeWaiverFor(contract, criterion.criterion_id, now)) {
      reasons.push(
        `Acceptance criterion ${criterion.criterion_id} is ${criterion.status} without an active waiver.`
      );
    }
  }
  return { passed: reasons.length === 0, reasons };
}

export function evaluateDefinitionOfDone(
  contract: SoftwareQualityContract,
  now = new Date()
): QualityEvaluation {
  const acceptance = evaluateAcceptanceCriteria(contract, now);
  const dod = evaluateChecks(contract.dod, contract, now, 'DoD');
  return {
    passed: acceptance.passed && dod.passed,
    reasons: [...acceptance.reasons, ...dod.reasons],
  };
}

export function evaluateTestTraceability(input: {
  contract: SoftwareQualityContract;
  inventory: TestInventory;
  requiredRiskRefs?: string[];
}): QualityEvaluation {
  const reasons: string[] = [];
  const requirementCoverage = new Set(
    input.inventory.items.flatMap((item) => item.requirement_refs ?? [])
  );
  const acceptanceCoverage = new Set(
    input.inventory.items.flatMap((item) => item.acceptance_criteria_refs ?? [])
  );
  const riskCoverage = new Set(input.inventory.items.flatMap((item) => item.risk_refs ?? []));

  for (const requirementId of input.contract.must_have_requirement_ids ?? []) {
    if (!requirementCoverage.has(requirementId)) {
      reasons.push(`Must-have requirement is not covered: ${requirementId}.`);
    }
  }
  for (const criterion of input.contract.acceptance_criteria) {
    if (!acceptanceCoverage.has(criterion.criterion_id)) {
      reasons.push(`Acceptance criterion is not covered: ${criterion.criterion_id}.`);
    }
  }
  for (const riskRef of input.requiredRiskRefs ?? []) {
    if (!riskCoverage.has(riskRef)) reasons.push(`Required risk is not covered: ${riskRef}.`);
  }
  for (const item of input.inventory.items) {
    if (item.viewpoint_ids.length === 0) {
      reasons.push(`Test inventory item has no viewpoint: ${item.item_id}.`);
    }
    if (!item.expected_result.trim()) {
      reasons.push(`Test inventory item has no expected result: ${item.item_id}.`);
    }
    if (item.execution_mode === 'prohibited' && !item.omission_reason?.trim()) {
      reasons.push(`Prohibited test inventory item lacks an omission reason: ${item.item_id}.`);
    }
  }
  return { passed: reasons.length === 0, reasons };
}

export function createDefectCandidates(input: {
  inventory: TestInventory;
  execution: TestExecutionRecord;
}): DefectCandidate[] {
  const inventoryById = new Map(input.inventory.items.map((item) => [item.item_id, item]));
  return input.execution.results
    .filter((result) => result.status === 'failed' || result.status === 'error')
    .map((result) => {
      const item = inventoryById.get(result.item_id);
      const severity =
        item?.risk_level === 'critical'
          ? 'critical'
          : item?.risk_level === 'high'
            ? 'major'
            : 'minor';
      return {
        defect_id: `DEF-${input.execution.run_id}-${result.item_id}`,
        source_test_refs: [result.item_id],
        title: `${result.status === 'error' ? 'Test execution error' : 'Test failed'}: ${item?.title ?? result.item_id}`,
        status: 'candidate' as const,
        severity,
        expected_result: item?.expected_result ?? 'Expected result was not recorded.',
        observed_result: result.observed_result ?? `Execution status: ${result.status}`,
        evidence_refs: result.evidence_refs,
      };
    });
}

export function buildSoftwareQualityReport(input: {
  contract: SoftwareQualityContract;
  inventory: TestInventory;
  execution: TestExecutionRecord;
  requiredRiskRefs?: string[];
  now?: Date;
}): SoftwareQualityReportSummary {
  const now = input.now ?? new Date();
  const dor = evaluateDefinitionOfReady(input.contract, now);
  const acceptance = evaluateAcceptanceCriteria(input.contract, now);
  const dod = evaluateDefinitionOfDone(input.contract, now);
  const traceability = evaluateTestTraceability({
    contract: input.contract,
    inventory: input.inventory,
    requiredRiskRefs: input.requiredRiskRefs,
  });
  const defects = createDefectCandidates({
    inventory: input.inventory,
    execution: input.execution,
  });
  const executionCounts: Record<string, number> = { planned: input.inventory.items.length };
  for (const result of input.execution.results) {
    executionCounts[result.status] = (executionCounts[result.status] ?? 0) + 1;
  }
  const missingEvidence = input.execution.results.filter(
    (result) => result.evidence_refs.length === 0
  );
  const unexecuted = input.inventory.items.filter(
    (item) => !input.execution.results.some((result) => result.item_id === item.item_id)
  );
  const reasons: string[] = [];
  let recommendation: SoftwareQualityReportSummary['recommendation'] = 'go';
  if (!traceability.passed || missingEvidence.length > 0 || unexecuted.length > 0) {
    recommendation = 'insufficient_evidence';
    reasons.push(...traceability.reasons);
    if (missingEvidence.length > 0)
      reasons.push(`${missingEvidence.length} result(s) lack evidence.`);
    if (unexecuted.length > 0)
      reasons.push(`${unexecuted.length} planned test(s) were not executed.`);
  } else if (!dor.passed || !acceptance.passed || !dod.passed || defects.length > 0) {
    recommendation = 'no_go';
    reasons.push(...dor.reasons, ...acceptance.reasons, ...dod.reasons);
    if (defects.length > 0) reasons.push(`${defects.length} defect candidate(s) remain.`);
  }
  const evidenceRefs = Array.from(
    new Set(input.execution.results.flatMap((result) => result.evidence_refs))
  );
  return {
    gate_status: {
      dor: dor.passed ? 'pass' : 'fail',
      acceptance_criteria: acceptance.passed ? 'pass' : 'fail',
      dod: dod.passed ? 'pass' : 'fail',
    },
    coverage: {
      required:
        (input.contract.must_have_requirement_ids?.length ?? 0) +
        input.contract.acceptance_criteria.length +
        (input.requiredRiskRefs?.length ?? 0),
      covered: traceability.passed
        ? (input.contract.must_have_requirement_ids?.length ?? 0) +
          input.contract.acceptance_criteria.length +
          (input.requiredRiskRefs?.length ?? 0)
        : 0,
    },
    execution: executionCounts,
    defects: {
      candidates: defects.length,
      critical: defects.filter((defect) => defect.severity === 'critical').length,
      major: defects.filter((defect) => defect.severity === 'major').length,
    },
    residual_risks: reasons,
    recommendation,
    recommendation_reasons: reasons,
    evidence_refs: evidenceRefs,
    accountable_human_id: input.contract.accountable_human_id,
    human_decision: 'pending',
  };
}
