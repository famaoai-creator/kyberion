import { createHash } from 'node:crypto';
import {
  evaluateAutonomousOpsAction,
  getAutonomousOpsPolicy,
  matchHighRiskPaths,
  type AutonomousOpsDecision,
  type AutonomousOpsPolicy,
} from './autonomous-ops-gate.js';
import type { FactoryAutonomyPolicy } from './factory-policy.js';

export type FactoryCiFailureClass =
  | 'generated-drift'
  | 'ratchet/registration'
  | 'gate-failure'
  | 'test-failure'
  | 'platform'
  | 'infra'
  | 'unknown';

export interface FactoryCiFailureRecord {
  class: FactoryCiFailureClass;
  signature: string;
  title: string;
  gate?: string;
  file?: string;
  test?: string;
  next: string[];
  suspectedFlake?: boolean;
  changed?: string[];
  evidence?: string[];
}

export type FactoryCiAutofixAction =
  'run_resolve_generated' | 'queue_code_repair' | 'retry_ci_or_wait' | 'escalate_human';

export type FactoryCiAutofixStopReason =
  | 'duplicate_failure_signature'
  | 'attempt_cap_reached'
  | 'non_auto_failure_class'
  | 'shadow_mode'
  | 'gate_denied'
  | 'high_risk_path'
  | 'empty_failures';

export interface FactoryCiAutofixPlanInput {
  failures: readonly FactoryCiFailureRecord[];
  priorSignatures: readonly string[];
  attemptsUsed: number;
  maxAttempts?: number;
  tenantSlug?: string;
  changedPaths?: readonly string[];
  factoryPolicy?: FactoryAutonomyPolicy;
}

export interface FactoryCiAutofixDecision {
  action: FactoryCiAutofixAction;
  allowed: boolean;
  stop_reason?: FactoryCiAutofixStopReason;
  reason: string;
  primary_signature?: string;
  primary_class?: FactoryCiFailureClass;
  observed_signatures: string[];
  next_commands: string[];
  effective_max_attempts: number;
  gate_decision?: AutonomousOpsDecision;
  gate_shadow?: boolean;
}

export type FactoryCiPatchViolationCode =
  'touches_baseline_or_config' | 'weakens_or_skips_checks' | 'removes_test_assertions';

export interface FactoryCiPatchGuardResult {
  ok: boolean;
  escalate_to_approve: boolean;
  violations: Array<{
    code: FactoryCiPatchViolationCode;
    detail: string;
    paths: string[];
  }>;
}

const MAX_CI_AUTOFIX_ATTEMPTS = 3;
const RESOLVE_GENERATED_CMD = 'pnpm kyberion resolve generated';

const FRESHNESS_GATE_RE =
  /\b(store-roots|org-role-grants|op-registry|pseudo-locale|vocabulary-types|pii-rules|cli-reference|capability-seams|package-dependency-graph|subagent-definitions|provider-hooks|env-registry|knowledge-index|changelog-fragments|resolve generated)\b/iu;
const RATCHET_RE = /\b(baseline|allowlist|ratchet|not registered)\b/iu;
const INFRA_RE =
  /\b(timeout|timed out|rate limit|503|ENOTFOUND|ECONNRESET|ETIMEDOUT|EADDRINUSE|runner)\b/iu;
const TEST_FAILURE_RE = /\b(vitest|test|spec\.ts|test\.ts)\b/iu;
const GATE_FAILURE_RE = /\b(pnpm check|typecheck|lint|tsc|eslint)\b/iu;

const BASELINE_OR_CONFIG_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)[^/]*baseline[^/]*\.json$/iu,
  /\.snap$/iu,
  /(?:^|\/)vitest\.config\.[^/]+$/iu,
  /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/iu,
  /(?:^|\/)eslint\.config\.[^/]+$/iu,
  /(?:^|\/)\.eslintrc(?:\.[^/]+)?$/iu,
  /^knowledge\/product\/governance\/[^/]+\.json$/iu,
];

const TS_IGNORE_MARKER = `// ${'@'}ts-ignore`;
const TS_EXPECT_ERROR_MARKER = `// ${'@'}ts-expect-error`;

const WEAKENING_TOKENS: readonly string[] = [
  '.skip(',
  '.only(',
  'it.todo(',
  'test.todo(',
  'describe.skip(',
  TS_IGNORE_MARKER,
  TS_EXPECT_ERROR_MARKER,
  'eslint-disable',
];

export function computeFactoryCiSignature(parts: ReadonlyArray<string | undefined>): string {
  return createHash('sha256')
    .update(parts.filter(Boolean).join('|').replace(/\d+/gu, '#'))
    .digest('hex')
    .slice(0, 12);
}

export function classifyCiProofFailure(ci: {
  requiredChecks: readonly string[];
  reasons: readonly string[];
}): FactoryCiFailureRecord {
  const checks = [
    ...new Set(ci.requiredChecks.map((entry) => entry.trim()).filter(Boolean)),
  ].sort();
  const reasons = ci.reasons.map((entry) => entry.trim()).filter(Boolean);
  const combined = [...checks, ...reasons].join(' | ');

  let failureClass: FactoryCiFailureClass = 'unknown';
  let next: string[] = [];

  if (FRESHNESS_GATE_RE.test(combined)) {
    failureClass = 'generated-drift';
    next = [RESOLVE_GENERATED_CMD];
  } else if (RATCHET_RE.test(combined)) {
    failureClass = 'ratchet/registration';
    next = ['pnpm check -- --changed'];
  } else if (INFRA_RE.test(combined)) {
    failureClass = 'infra';
    next = [];
  } else if (TEST_FAILURE_RE.test(combined)) {
    failureClass = 'test-failure';
    next = ['pnpm exec vitest run --changed origin/main'];
  } else if (GATE_FAILURE_RE.test(combined)) {
    failureClass = 'gate-failure';
    next = ['pnpm check -- --changed'];
  }

  const normalizedSummary = combined || 'required check failed';
  return {
    class: failureClass,
    signature: computeFactoryCiSignature([failureClass, ...checks, normalizedSummary]),
    title: reasons[0] ?? (checks.length > 0 ? `CI failure (${checks.join(', ')})` : 'CI failure'),
    ...(checks[0] ? { gate: checks[0] } : {}),
    next,
    ...(failureClass === 'infra' ? { suspectedFlake: true } : {}),
    evidence: reasons.slice(0, 8),
  };
}

function collectCommands(failures: readonly FactoryCiFailureRecord[]): string[] {
  const commands: string[] = [];
  for (const failure of failures) {
    for (const cmd of failure.next) {
      const trimmed = cmd.trim();
      if (trimmed && !commands.includes(trimmed)) commands.push(trimmed);
    }
  }
  return commands;
}

export function planFactoryCiAutofix(input: FactoryCiAutofixPlanInput): FactoryCiAutofixDecision {
  const requestedCap = input.maxAttempts ?? MAX_CI_AUTOFIX_ATTEMPTS;
  const baselineMaxAttempts = Number.isFinite(requestedCap)
    ? Math.max(0, Math.min(Math.trunc(requestedCap), MAX_CI_AUTOFIX_ATTEMPTS))
    : MAX_CI_AUTOFIX_ATTEMPTS;

  const observedSignatures = [...new Set(input.failures.map((f) => f.signature).filter(Boolean))];
  if (input.failures.length === 0) {
    return {
      action: 'escalate_human',
      allowed: false,
      stop_reason: 'empty_failures',
      reason: 'No structured CI failure records supplied; escalating to operator',
      observed_signatures: [],
      next_commands: [],
      effective_max_attempts: baselineMaxAttempts,
    };
  }

  const primary = input.failures[0];
  const priorSet = new Set(input.priorSignatures);
  const duplicateFailure = input.failures.find((failure) => priorSet.has(failure.signature));
  if (duplicateFailure) {
    return {
      action: 'escalate_human',
      allowed: false,
      stop_reason: 'duplicate_failure_signature',
      reason: `Repeated CI failure signature ${duplicateFailure.signature} (${duplicateFailure.class}); stopping autonomous repair`,
      primary_signature: duplicateFailure.signature,
      primary_class: duplicateFailure.class,
      observed_signatures: observedSignatures,
      next_commands: collectCommands(input.failures),
      effective_max_attempts: baselineMaxAttempts,
    };
  }

  if (input.attemptsUsed >= baselineMaxAttempts) {
    return {
      action: 'escalate_human',
      allowed: false,
      stop_reason: 'attempt_cap_reached',
      reason: `CI autofix attempt cap reached (${input.attemptsUsed}/${baselineMaxAttempts})`,
      primary_signature: primary.signature,
      primary_class: primary.class,
      observed_signatures: observedSignatures,
      next_commands: collectCommands(input.failures),
      effective_max_attempts: baselineMaxAttempts,
    };
  }

  const nonAutoFailure = input.failures.find(
    (failure) =>
      failure.class === 'ratchet/registration' ||
      failure.class === 'unknown' ||
      (failure.class === 'platform' && failure.suspectedFlake !== true)
  );
  if (nonAutoFailure) {
    return {
      action: 'escalate_human',
      allowed: false,
      stop_reason: 'non_auto_failure_class',
      reason: `Failure class '${nonAutoFailure.class}' (${nonAutoFailure.signature}) requires human review`,
      primary_signature: nonAutoFailure.signature,
      primary_class: nonAutoFailure.class,
      observed_signatures: observedSignatures,
      next_commands: collectCommands(input.failures),
      effective_max_attempts: baselineMaxAttempts,
    };
  }

  const combinedPaths = [
    ...new Set([
      ...(input.changedPaths ?? []),
      ...input.failures.flatMap((failure) => failure.changed ?? []),
    ]),
  ].sort();

  const gate = evaluateAutonomousOpsAction({
    actionId: 'ci_autofix_attempt',
    tenantSlug: input.tenantSlug,
    executionMode: 'apply',
    changedPaths: combinedPaths,
    factoryPolicy: input.factoryPolicy,
  });

  const effectiveMaxAttempts = Math.max(
    0,
    Math.min(baselineMaxAttempts, gate.maxAttempts ?? MAX_CI_AUTOFIX_ATTEMPTS)
  );
  if (input.attemptsUsed >= effectiveMaxAttempts) {
    return {
      action: 'escalate_human',
      allowed: false,
      stop_reason: 'attempt_cap_reached',
      reason: `CI autofix attempt cap reached (${input.attemptsUsed}/${effectiveMaxAttempts})`,
      primary_signature: primary.signature,
      primary_class: primary.class,
      observed_signatures: observedSignatures,
      next_commands: collectCommands(input.failures),
      effective_max_attempts: effectiveMaxAttempts,
      gate_decision: gate.decision,
      gate_shadow: gate.shadow,
    };
  }

  if (!gate.allowed) {
    const stopReason: FactoryCiAutofixStopReason =
      gate.highRiskPathMatches.length > 0
        ? 'high_risk_path'
        : gate.shadow
          ? 'shadow_mode'
          : 'gate_denied';
    return {
      action: 'escalate_human',
      allowed: false,
      stop_reason: stopReason,
      reason: `ci_autofix_attempt blocked (${stopReason}): ${gate.reason}`,
      primary_signature: primary.signature,
      primary_class: primary.class,
      observed_signatures: observedSignatures,
      next_commands: collectCommands(input.failures),
      effective_max_attempts: effectiveMaxAttempts,
      gate_decision: gate.decision,
      gate_shadow: gate.shadow,
    };
  }

  const allTransientOrFlake = input.failures.every(
    (failure) =>
      failure.class === 'infra' || (failure.class === 'platform' && failure.suspectedFlake === true)
  );
  if (allTransientOrFlake) {
    return {
      action: 'retry_ci_or_wait',
      allowed: true,
      reason: `Transient ${primary.class} failure (${primary.signature}); retrying without code mutation`,
      primary_signature: primary.signature,
      primary_class: primary.class,
      observed_signatures: observedSignatures,
      next_commands: collectCommands(input.failures),
      effective_max_attempts: effectiveMaxAttempts,
      gate_decision: gate.decision,
      gate_shadow: gate.shadow,
    };
  }

  const commands = collectCommands(input.failures);
  const allGeneratedDrift = input.failures.every((failure) => failure.class === 'generated-drift');
  if (allGeneratedDrift) {
    const resolveCommands = commands.includes(RESOLVE_GENERATED_CMD)
      ? commands
      : [RESOLVE_GENERATED_CMD, ...commands];
    return {
      action: 'run_resolve_generated',
      allowed: true,
      reason: `Generated file drift (${primary.signature}); run resolve generated and re-verify`,
      primary_signature: primary.signature,
      primary_class: primary.class,
      observed_signatures: observedSignatures,
      next_commands: resolveCommands,
      effective_max_attempts: effectiveMaxAttempts,
      gate_decision: gate.decision,
      gate_shadow: gate.shadow,
    };
  }

  return {
    action: 'queue_code_repair',
    allowed: true,
    reason: `Bounded CI repair queued for ${primary.class} (${primary.signature})`,
    primary_signature: primary.signature,
    primary_class: primary.class,
    observed_signatures: observedSignatures,
    next_commands: commands,
    effective_max_attempts: effectiveMaxAttempts,
    gate_decision: gate.decision,
    gate_shadow: gate.shadow,
  };
}

function countAssertionCalls(line: string): number {
  const matches = line.match(/\bexpect\s*\(|\bassert(?:\.[a-zA-Z0-9_]+)?\s*\(/gu);
  return matches ? matches.length : 0;
}

export function validateCiAutofixPatchGuard(input: {
  changedPaths: readonly string[];
  patchText?: string;
  policy?: AutonomousOpsPolicy;
}): FactoryCiPatchGuardResult {
  const normalizedPaths = [
    ...new Set(
      input.changedPaths
        .map((entry) =>
          entry
            .trim()
            .replace(/\\/g, '/')
            .replace(/^(?:\.\/)+/u, '')
        )
        .filter(Boolean)
    ),
  ].sort();

  const violations: FactoryCiPatchGuardResult['violations'] = [];

  let highRiskPatterns: string[] = [];
  let policyUnavailable = false;
  try {
    const policy = input.policy ?? getAutonomousOpsPolicy();
    highRiskPatterns = policy.high_risk_paths ?? [];
  } catch {
    policyUnavailable = true;
  }

  if (policyUnavailable) {
    violations.push({
      code: 'touches_baseline_or_config',
      detail: 'Autonomous ops policy unavailable; failing closed on CI autofix patch guard',
      paths: normalizedPaths,
    });
  } else {
    const highRiskHits = new Set(matchHighRiskPaths(normalizedPaths, highRiskPatterns));
    for (const filePath of normalizedPaths) {
      if (BASELINE_OR_CONFIG_PATTERNS.some((pattern) => pattern.test(filePath))) {
        highRiskHits.add(filePath);
      }
    }
    const baselineOrConfigPaths = [...highRiskHits].sort();
    if (baselineOrConfigPaths.length > 0) {
      violations.push({
        code: 'touches_baseline_or_config',
        detail: `CI autofix patch touches protected baseline, config, or high-risk files: ${baselineOrConfigPaths.join(', ')}`,
        paths: baselineOrConfigPaths,
      });
    }
  }

  if (input.patchText) {
    const addedWeakeningHits = new Set<string>();
    const hasTestPaths = normalizedPaths.some((entry) =>
      /\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(entry)
    );
    let currentFile: string | undefined;
    let addedTestExpects = 0;
    let removedTestExpects = 0;

    for (const rawLine of input.patchText.split('\n')) {
      if (rawLine.startsWith('+++ b/')) {
        currentFile = rawLine.slice(6).trim();
        continue;
      }
      if (rawLine.startsWith('--- ')) continue;

      if (rawLine.startsWith('+')) {
        const added = rawLine.slice(1);
        for (const token of WEAKENING_TOKENS) {
          if (added.includes(token)) addedWeakeningHits.add(token);
        }
        const inTestFile = currentFile
          ? /\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(currentFile)
          : hasTestPaths;
        if (inTestFile) addedTestExpects += countAssertionCalls(added);
      } else if (rawLine.startsWith('-')) {
        const removed = rawLine.slice(1);
        const inTestFile = currentFile
          ? /\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(currentFile)
          : hasTestPaths;
        if (inTestFile) removedTestExpects += countAssertionCalls(removed);
      }
    }

    if (addedWeakeningHits.size > 0) {
      violations.push({
        code: 'weakens_or_skips_checks',
        detail: `CI autofix patch introduces test-skipping or lint/type suppression markers: ${[...addedWeakeningHits].sort().join(', ')}`,
        paths: normalizedPaths,
      });
    }

    if (removedTestExpects > addedTestExpects) {
      violations.push({
        code: 'removes_test_assertions',
        detail: `CI autofix patch removes test assertions (${removedTestExpects} removed vs ${addedTestExpects} added)`,
        paths: normalizedPaths.filter((entry) => /\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(entry)),
      });
    }
  }

  return {
    ok: violations.length === 0,
    escalate_to_approve: violations.length > 0,
    violations,
  };
}
