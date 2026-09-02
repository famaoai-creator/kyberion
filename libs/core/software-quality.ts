import { parseSafeJsonObjectValue } from './foundation/safe-json.js';

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
  preconditions?: string[];
  steps?: string[];
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  expected_result: string;
  test_level?:
    | 'unit'
    | 'component'
    | 'contract'
    | 'integration'
    | 'e2e'
    | 'acceptance'
    | 'exploratory'
    | 'static';
  execution_mode: 'safe_auto' | 'approval_required' | 'manual_only' | 'prohibited';
  automation_backend?: string;
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
  defect_refs?: string[];
  retry_of?: string;
}

export interface TestExecutionRecord {
  version?: string;
  run_id: string;
  project_id?: string;
  subject_ref: string;
  environment?: string;
  executor?: {
    resource_id: string;
    resource_type: 'human' | 'ai_agent' | 'automation';
  };
  started_at?: string;
  finished_at?: string;
  results: TestExecutionResult[];
}

const QUALITY_CHECK_STATUSES = new Set<QualityCheckStatus>([
  'pending',
  'passed',
  'failed',
  'waived',
]);
const TEST_RISK_LEVELS = new Set<TestInventoryItem['risk_level']>([
  'low',
  'medium',
  'high',
  'critical',
]);
const TEST_LEVELS = new Set<NonNullable<TestInventoryItem['test_level']>>([
  'unit',
  'component',
  'contract',
  'integration',
  'e2e',
  'acceptance',
  'exploratory',
  'static',
]);
const EXECUTION_MODES = new Set<TestInventoryItem['execution_mode']>([
  'safe_auto',
  'approval_required',
  'manual_only',
  'prohibited',
]);
const AUTOMATION_ACTUATORS = new Set<NonNullable<TestInventoryItem['automation']>['actuator']>([
  'code',
  'system',
  'browser',
  'network',
]);
const EXECUTION_RESULT_STATUSES = new Set<TestExecutionResult['status']>([
  'passed',
  'failed',
  'error',
  'blocked',
  'skipped',
]);
const EXECUTOR_RESOURCE_TYPES = new Set<
  NonNullable<TestExecutionRecord['executor']>['resource_type']
>(['human', 'ai_agent', 'automation']);

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(record).every((key) => allowedKeys.has(key));
}

function requiredText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function optionalText(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return requiredText(value);
}

function stringList(
  value: unknown,
  options: { minItems?: number; unique?: boolean } = {}
): string[] | null {
  if (!Array.isArray(value)) return null;
  const values = value.map((item) => requiredText(item));
  if (values.some((item): item is null => item === null)) return null;
  const result = values as string[];
  if ((options.minItems ?? 0) > result.length) return null;
  if (options.unique && new Set(result).size !== result.length) return null;
  return result;
}

function isDateTime(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function parseQualityCheck(value: unknown): QualityCheck | null {
  try {
    const record = parseSafeJsonObjectValue(value, 'software quality check');
    if (
      !hasOnlyKeys(record, [
        'check_id',
        'description',
        'status',
        'evidence_refs',
        'owner_id',
        'blocking',
      ])
    ) {
      return null;
    }
    const checkId = requiredText(record.check_id);
    const description = requiredText(record.description);
    if (
      !checkId ||
      !description ||
      !QUALITY_CHECK_STATUSES.has(record.status as QualityCheckStatus)
    ) {
      return null;
    }
    const evidenceRefs =
      record.evidence_refs === undefined
        ? undefined
        : stringList(record.evidence_refs, { unique: true });
    if (record.evidence_refs !== undefined && !evidenceRefs) return null;
    const ownerId = optionalText(record.owner_id);
    if (record.owner_id !== undefined && !ownerId) return null;
    if (record.blocking !== undefined && typeof record.blocking !== 'boolean') return null;
    const blocking: boolean | undefined =
      typeof record.blocking === 'boolean' ? record.blocking : undefined;
    return {
      check_id: checkId,
      description,
      status: record.status as QualityCheckStatus,
      ...(evidenceRefs ? { evidence_refs: evidenceRefs } : {}),
      ...(ownerId ? { owner_id: ownerId } : {}),
      ...(blocking !== undefined ? { blocking } : {}),
    };
  } catch {
    return null;
  }
}

function parseAcceptanceCriterion(value: unknown): AcceptanceCriterion | null {
  try {
    const record = parseSafeJsonObjectValue(value, 'software quality acceptance criterion');
    if (
      !hasOnlyKeys(record, [
        'criterion_id',
        'description',
        'requirement_refs',
        'expected_result',
        'status',
        'evidence_refs',
      ])
    ) {
      return null;
    }
    const criterionId = requiredText(record.criterion_id);
    const description = requiredText(record.description);
    const requirementRefs = stringList(record.requirement_refs, { minItems: 1, unique: true });
    const expectedResult = requiredText(record.expected_result);
    if (
      !criterionId ||
      !description ||
      !requirementRefs ||
      !expectedResult ||
      !QUALITY_CHECK_STATUSES.has(record.status as QualityCheckStatus)
    ) {
      return null;
    }
    const evidenceRefs =
      record.evidence_refs === undefined
        ? undefined
        : stringList(record.evidence_refs, { unique: true });
    if (record.evidence_refs !== undefined && !evidenceRefs) return null;
    return {
      criterion_id: criterionId,
      description,
      requirement_refs: requirementRefs,
      expected_result: expectedResult,
      status: record.status as QualityCheckStatus,
      ...(evidenceRefs ? { evidence_refs: evidenceRefs } : {}),
    };
  } catch {
    return null;
  }
}

function parseQualityWaiver(value: unknown): QualityWaiver | null {
  try {
    const record = parseSafeJsonObjectValue(value, 'software quality waiver');
    if (
      !hasOnlyKeys(record, [
        'waiver_id',
        'check_refs',
        'reason',
        'accountable_human_id',
        'expires_at',
        'compensating_controls',
        'residual_risk',
      ])
    ) {
      return null;
    }
    const waiverId = requiredText(record.waiver_id);
    const checkRefs = stringList(record.check_refs, { minItems: 1, unique: true });
    const reason = requiredText(record.reason);
    const accountableHumanId = requiredText(record.accountable_human_id);
    const expiresAt = requiredText(record.expires_at);
    const compensatingControls = stringList(record.compensating_controls, { minItems: 1 });
    const residualRisk = requiredText(record.residual_risk);
    if (
      !waiverId ||
      !checkRefs ||
      !reason ||
      !accountableHumanId ||
      !expiresAt ||
      !isDateTime(expiresAt) ||
      !compensatingControls ||
      !residualRisk
    ) {
      return null;
    }
    return {
      waiver_id: waiverId,
      check_refs: checkRefs,
      reason,
      accountable_human_id: accountableHumanId,
      expires_at: expiresAt,
      compensating_controls: compensatingControls,
      residual_risk: residualRisk,
    };
  } catch {
    return null;
  }
}

/** Parse a quality contract before a gate or report evaluation can consume it. */
export function parseSoftwareQualityContract(value: unknown): SoftwareQualityContract | null {
  try {
    const record = parseSafeJsonObjectValue(value, 'software quality contract');
    if (
      !hasOnlyKeys(record, [
        'version',
        'project_id',
        'accountable_human_id',
        'must_have_requirement_ids',
        'dor',
        'acceptance_criteria',
        'dod',
        'waivers',
      ])
    ) {
      return null;
    }
    const version = requiredText(record.version);
    const projectId = requiredText(record.project_id);
    const accountableHumanId = requiredText(record.accountable_human_id);
    const dor = Array.isArray(record.dor) ? record.dor.map(parseQualityCheck) : null;
    const acceptanceCriteria = Array.isArray(record.acceptance_criteria)
      ? record.acceptance_criteria.map(parseAcceptanceCriterion)
      : null;
    const dod = Array.isArray(record.dod) ? record.dod.map(parseQualityCheck) : null;
    if (
      !version ||
      !projectId ||
      !accountableHumanId ||
      !dor ||
      dor.length === 0 ||
      dor.some((item) => item === null) ||
      !acceptanceCriteria ||
      acceptanceCriteria.length === 0 ||
      acceptanceCriteria.some((item) => item === null) ||
      !dod ||
      dod.length === 0 ||
      dod.some((item) => item === null)
    ) {
      return null;
    }
    const mustHaveRequirementIds =
      record.must_have_requirement_ids === undefined
        ? undefined
        : stringList(record.must_have_requirement_ids, { unique: true });
    if (record.must_have_requirement_ids !== undefined && !mustHaveRequirementIds) return null;
    const waivers =
      record.waivers === undefined
        ? undefined
        : Array.isArray(record.waivers)
          ? record.waivers.map(parseQualityWaiver)
          : null;
    if (record.waivers !== undefined && (!waivers || waivers.some((item) => item === null))) {
      return null;
    }
    return {
      version,
      project_id: projectId,
      accountable_human_id: accountableHumanId,
      dor: dor as QualityCheck[],
      acceptance_criteria: acceptanceCriteria as AcceptanceCriterion[],
      dod: dod as QualityCheck[],
      ...(mustHaveRequirementIds ? { must_have_requirement_ids: mustHaveRequirementIds } : {}),
      ...(waivers ? { waivers: waivers as QualityWaiver[] } : {}),
    };
  } catch {
    return null;
  }
}

export function parseTestInventoryItem(value: unknown): TestInventoryItem | null {
  try {
    const record = parseSafeJsonObjectValue(value, 'test inventory item');
    if (
      !hasOnlyKeys(record, [
        'item_id',
        'title',
        'viewpoint_ids',
        'requirement_refs',
        'acceptance_criteria_refs',
        'risk_refs',
        'preconditions',
        'steps',
        'risk_level',
        'expected_result',
        'test_level',
        'execution_mode',
        'automation_backend',
        'automation',
        'omission_reason',
      ])
    ) {
      return null;
    }
    const itemId = requiredText(record.item_id);
    const title = requiredText(record.title);
    const viewpointIds = stringList(record.viewpoint_ids, { minItems: 1, unique: true });
    const expectedResult = requiredText(record.expected_result);
    if (
      !itemId ||
      !title ||
      !viewpointIds ||
      !expectedResult ||
      !TEST_RISK_LEVELS.has(record.risk_level as TestInventoryItem['risk_level']) ||
      !EXECUTION_MODES.has(record.execution_mode as TestInventoryItem['execution_mode'])
    ) {
      return null;
    }
    const optionalRefs: Record<string, string[] | undefined | null> = {
      requirement_refs:
        record.requirement_refs === undefined
          ? undefined
          : stringList(record.requirement_refs, { unique: true }),
      acceptance_criteria_refs:
        record.acceptance_criteria_refs === undefined
          ? undefined
          : stringList(record.acceptance_criteria_refs, { unique: true }),
      risk_refs:
        record.risk_refs === undefined ? undefined : stringList(record.risk_refs, { unique: true }),
      preconditions:
        record.preconditions === undefined ? undefined : stringList(record.preconditions),
      steps: record.steps === undefined ? undefined : stringList(record.steps),
    };
    if (Object.values(optionalRefs).some((item) => item === null)) return null;
    const testLevel = record.test_level === undefined ? undefined : record.test_level;
    if (
      testLevel !== undefined &&
      !TEST_LEVELS.has(testLevel as NonNullable<TestInventoryItem['test_level']>)
    ) {
      return null;
    }
    const automationBackend = optionalText(record.automation_backend);
    if (record.automation_backend !== undefined && !automationBackend) return null;
    const omissionReason = optionalText(record.omission_reason);
    if (record.omission_reason !== undefined && !omissionReason) return null;
    let automation: TestInventoryItem['automation'];
    if (record.automation !== undefined) {
      const automationRecord = parseSafeJsonObjectValue(
        record.automation,
        'test inventory automation'
      );
      if (!hasOnlyKeys(automationRecord, ['actuator', 'op', 'params'])) return null;
      const op = requiredText(automationRecord.op);
      const params = parseSafeJsonObjectValue(
        automationRecord.params,
        'test inventory automation.params'
      );
      if (
        !AUTOMATION_ACTUATORS.has(
          automationRecord.actuator as NonNullable<TestInventoryItem['automation']>['actuator']
        ) ||
        !op ||
        !/^[a-z][a-z0-9_]*$/u.test(op)
      ) {
        return null;
      }
      automation = {
        actuator: automationRecord.actuator as NonNullable<
          TestInventoryItem['automation']
        >['actuator'],
        op,
        params,
      };
    }
    return {
      item_id: itemId,
      title,
      viewpoint_ids: viewpointIds,
      ...(optionalRefs.requirement_refs ? { requirement_refs: optionalRefs.requirement_refs } : {}),
      ...(optionalRefs.acceptance_criteria_refs
        ? { acceptance_criteria_refs: optionalRefs.acceptance_criteria_refs }
        : {}),
      ...(optionalRefs.risk_refs ? { risk_refs: optionalRefs.risk_refs } : {}),
      ...(optionalRefs.preconditions ? { preconditions: optionalRefs.preconditions } : {}),
      ...(optionalRefs.steps ? { steps: optionalRefs.steps } : {}),
      risk_level: record.risk_level as TestInventoryItem['risk_level'],
      expected_result: expectedResult,
      ...(testLevel ? { test_level: testLevel as TestInventoryItem['test_level'] } : {}),
      execution_mode: record.execution_mode as TestInventoryItem['execution_mode'],
      ...(automationBackend ? { automation_backend: automationBackend } : {}),
      ...(automation ? { automation } : {}),
      ...(omissionReason ? { omission_reason: omissionReason } : {}),
    };
  } catch {
    return null;
  }
}

/** Parse a test inventory before traceability or dispatch evaluation can consume it. */
export function parseTestInventory(value: unknown): TestInventory | null {
  try {
    const record = parseSafeJsonObjectValue(value, 'test inventory');
    if (!hasOnlyKeys(record, ['version', 'project_id', 'items'])) return null;
    const version = requiredText(record.version);
    const projectId = requiredText(record.project_id);
    const items = Array.isArray(record.items) ? record.items.map(parseTestInventoryItem) : null;
    if (!version || !projectId || !items || items.some((item) => item === null)) return null;
    return { version, project_id: projectId, items: items as TestInventoryItem[] };
  } catch {
    return null;
  }
}

function parseTestExecutionResult(value: unknown): TestExecutionResult | null {
  try {
    const record = parseSafeJsonObjectValue(value, 'test execution result');
    if (
      !hasOnlyKeys(record, [
        'item_id',
        'status',
        'evidence_refs',
        'observed_result',
        'defect_refs',
        'retry_of',
      ])
    ) {
      return null;
    }
    const itemId = requiredText(record.item_id);
    const evidenceRefs = stringList(record.evidence_refs);
    const observedResult: string | undefined =
      typeof record.observed_result === 'string' ? record.observed_result : undefined;
    if (
      !itemId ||
      !evidenceRefs ||
      !EXECUTION_RESULT_STATUSES.has(record.status as TestExecutionResult['status']) ||
      (observedResult !== undefined && typeof observedResult !== 'string')
    ) {
      return null;
    }
    const defectRefs =
      record.defect_refs === undefined ? undefined : stringList(record.defect_refs);
    const retryOf = optionalText(record.retry_of);
    if (
      (record.defect_refs !== undefined && !defectRefs) ||
      (record.retry_of !== undefined && !retryOf)
    ) {
      return null;
    }
    return {
      item_id: itemId,
      status: record.status as TestExecutionResult['status'],
      evidence_refs: evidenceRefs,
      ...(observedResult !== undefined ? { observed_result: observedResult } : {}),
      ...(defectRefs ? { defect_refs: defectRefs } : {}),
      ...(retryOf ? { retry_of: retryOf } : {}),
    };
  } catch {
    return null;
  }
}

/** Parse a persisted test execution record before report generation consumes it. */
export function parseTestExecutionRecord(value: unknown): TestExecutionRecord | null {
  try {
    const record = parseSafeJsonObjectValue(value, 'test execution record');
    if (
      !hasOnlyKeys(record, [
        'version',
        'run_id',
        'project_id',
        'subject_ref',
        'environment',
        'executor',
        'started_at',
        'finished_at',
        'results',
      ])
    ) {
      return null;
    }
    const version = requiredText(record.version);
    const runId = requiredText(record.run_id);
    const projectId = requiredText(record.project_id);
    const subjectRef = requiredText(record.subject_ref);
    const environment = requiredText(record.environment);
    const startedAt = requiredText(record.started_at);
    const finishedAt = requiredText(record.finished_at);
    const results = Array.isArray(record.results)
      ? record.results.map(parseTestExecutionResult)
      : null;
    if (
      !version ||
      !runId ||
      !projectId ||
      !subjectRef ||
      !environment ||
      !startedAt ||
      !isDateTime(startedAt) ||
      !finishedAt ||
      !isDateTime(finishedAt) ||
      !results ||
      results.some((item) => item === null)
    ) {
      return null;
    }
    const executorRecord = parseSafeJsonObjectValue(record.executor, 'test execution executor');
    if (!hasOnlyKeys(executorRecord, ['resource_id', 'resource_type'])) return null;
    const resourceId = requiredText(executorRecord.resource_id);
    if (
      !resourceId ||
      !EXECUTOR_RESOURCE_TYPES.has(
        executorRecord.resource_type as NonNullable<
          TestExecutionRecord['executor']
        >['resource_type']
      )
    ) {
      return null;
    }
    return {
      version,
      run_id: runId,
      project_id: projectId,
      subject_ref: subjectRef,
      environment,
      executor: {
        resource_id: resourceId,
        resource_type: executorRecord.resource_type as NonNullable<
          TestExecutionRecord['executor']
        >['resource_type'],
      },
      started_at: startedAt,
      finished_at: finishedAt,
      results: results as TestExecutionResult[],
    };
  } catch {
    return null;
  }
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
