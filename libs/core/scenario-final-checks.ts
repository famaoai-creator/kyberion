/**
 * ES-05: scenario final checks and per-turn checks.
 *
 * Every check reads the side-effect log the interceptor collected (plus the
 * finalized trace and the run root), never live process state, so a report
 * can be re-derived from the same evidence. Each pipeline op produces two
 * preflight records (source 'actuator' from adf-engine admission and
 * 'pipeline' from leaf dispatch); "called" therefore counts fixture-served
 * `apply` records, and for fixture-less passthrough ops the `pipeline`
 * preflight record — but never an invocation that failed closed
 * (`unstubbed`) or was held for approval.
 */

import * as path from 'node:path';
import type {
  ScenarioFinalCheck,
  ScenarioResponseMatcher,
  ScenarioTurnChecks,
} from './scenario-definition.js';
import type { ScenarioOpRecord, ScenarioSideEffectLog } from './scenario-side-effect-log.js';
import { safeExistsSync } from './secure-io.js';
import type { Trace, TraceSpan } from './src/trace.js';

export interface ScenarioCheckResult {
  type: string;
  pass: boolean;
  detail: string;
}

export interface ScenarioCheckContext {
  /** Absolute run root; artifactExists paths are resolved against it. */
  runRoot: string;
}

/** Inclusive-exclusive `seq` window used to scope per-turn checks. */
export interface ScenarioSeqWindow {
  fromSeq: number;
  toSeq: number;
}

function inWindow(seq: number, window?: ScenarioSeqWindow): boolean {
  return !window || (seq >= window.fromSeq && seq < window.toSeq);
}

function heldForApproval(record: ScenarioOpRecord): boolean {
  return record.requiresApproval === true && record.approvalGranted !== true;
}

/**
 * Op invocations that actually executed: fixture-served `apply` records, plus
 * `pipeline`-source preflight records of passthrough ops (no following
 * apply/unstubbed record for the same op, not held for approval).
 */
export function calledOpRecords(
  log: ScenarioSideEffectLog,
  op?: string,
  window?: ScenarioSeqWindow
): ScenarioOpRecord[] {
  const records = log.ops.filter((record) => inWindow(record.seq, window));
  const called: ScenarioOpRecord[] = [];
  records.forEach((record, index) => {
    if (op !== undefined && record.op !== op) return;
    if (record.stage === 'apply') {
      called.push(record);
      return;
    }
    if (record.stage !== 'preflight' || record.source !== 'pipeline' || heldForApproval(record)) {
      return;
    }
    const next = records.slice(index + 1).find((candidate) => candidate.op === record.op);
    if (next && (next.stage === 'apply' || next.stage === 'unstubbed')) return;
    called.push(record);
  });
  return called;
}

/** JSON-subset match: every key in `expected` must deep-match in `actual`. */
export function jsonSubsetMatches(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== 'object') {
    return Object.is(expected, actual);
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((item, index) => jsonSubsetMatches(item, actual[index]));
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const actualRecord = actual as Record<string, unknown>;
  return Object.entries(expected as Record<string, unknown>).every(
    ([key, value]) =>
      Object.hasOwn(actualRecord, key) && jsonSubsetMatches(value, actualRecord[key])
  );
}

function spanNames(span: TraceSpan, out: Set<string>): Set<string> {
  out.add(span.name);
  for (const child of span.children) spanNames(child, out);
  return out;
}

function resolveUnderRoot(runRoot: string, relativePath: string): string | null {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/u).includes('..')) return null;
  const resolved = path.resolve(runRoot, relativePath);
  const relative = path.relative(runRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

function result(type: string, pass: boolean, detail: string): ScenarioCheckResult {
  return { type, pass, detail };
}

function evaluateNoSideEffectOnReject(log: ScenarioSideEffectLog, op: string): ScenarioCheckResult {
  const type = 'noSideEffectOnReject';
  const rejections = log.approvals.filter(
    (record) => record.op === op && record.kind === 'requested' && record.decision === 'rejected'
  );
  if (rejections.length === 0) {
    return result(type, false, `no rejected approval was observed for ${op}`);
  }
  const decided = log.approvals.filter((record) => record.op === op && record.kind === 'decided');
  const called = calledOpRecords(log, op);
  for (const rejection of rejections) {
    const until =
      decided.find((record) => record.seq > rejection.seq)?.seq ?? Number.POSITIVE_INFINITY;
    const leaked = called.filter((record) => record.seq > rejection.seq && record.seq < until);
    if (leaked.length > 0) {
      return result(
        type,
        false,
        `${op} executed ${leaked.length} time(s) after its approval was rejected`
      );
    }
  }
  return result(type, true, `${rejections.length} rejection(s) of ${op} produced no execution`);
}

export function evaluateFinalCheck(
  check: ScenarioFinalCheck,
  log: ScenarioSideEffectLog,
  trace: Trace | undefined,
  ctx: ScenarioCheckContext
): ScenarioCheckResult {
  switch (check.type) {
    case 'opCalled': {
      const count = calledOpRecords(log, check.op).length;
      const pass = check.times === undefined ? count > 0 : count === check.times;
      const expected = check.times === undefined ? 'at least once' : `${check.times} time(s)`;
      return result(check.type, pass, `${check.op} called ${count} time(s), expected ${expected}`);
    }
    case 'opNotCalled': {
      const count = calledOpRecords(log, check.op).length;
      return result(check.type, count === 0, `${check.op} called ${count} time(s), expected 0`);
    }
    case 'opArgs': {
      const calls = calledOpRecords(log, check.op);
      const matched = calls.some((record) => jsonSubsetMatches(check.match, record.params ?? {}));
      return result(
        check.type,
        matched,
        matched
          ? `${check.op} was called with matching params`
          : `none of ${calls.length} call(s) of ${check.op} matched the expected params`
      );
    }
    case 'approvalRequested': {
      const count = log.approvals.filter(
        (record) => record.op === check.op && record.kind === 'requested'
      ).length;
      return result(check.type, count > 0, `${check.op} requested approval ${count} time(s)`);
    }
    case 'approvalTransition': {
      const matched = log.approvals.some(
        (record) =>
          record.op === check.op &&
          record.kind === 'decided' &&
          record.previous === check.from &&
          record.decision === check.to
      );
      return result(
        check.type,
        matched,
        `${check.op} ${matched ? 'transitioned' : 'did not transition'} ${check.from} -> ${check.to}`
      );
    }
    case 'noSideEffectOnReject':
      return evaluateNoSideEffectOnReject(log, check.op);
    case 'artifactExists': {
      const resolved = resolveUnderRoot(ctx.runRoot, check.path);
      if (!resolved) {
        return result(check.type, false, `artifact path escapes the run root: ${check.path}`);
      }
      const exists = safeExistsSync(resolved);
      return result(check.type, exists, `${check.path} ${exists ? 'exists' : 'is missing'}`);
    }
    case 'traceSpanExists': {
      if (!trace) return result(check.type, false, 'no trace was recorded');
      const exists = spanNames(trace.rootSpan, new Set()).has(check.name);
      return result(
        check.type,
        exists,
        `trace span ${check.name} ${exists ? 'exists' : 'is missing'}`
      );
    }
    default: {
      const unreachable: never = check;
      return result(
        String((unreachable as { type?: unknown }).type),
        false,
        'unknown final check type'
      );
    }
  }
}

/** Read a dot path (`a.b.0.c`) out of a turn's response object. */
export function readResponsePath(source: unknown, dotPath: string): unknown {
  return dotPath.split('.').reduce<unknown>((value, key) => {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value) && /^\d+$/u.test(key)) return value[Number(key)];
    if (typeof value === 'object' && Object.hasOwn(value as object, key)) {
      return (value as Record<string, unknown>)[key];
    }
    return undefined;
  }, source);
}

function evaluateResponseMatcher(
  matcher: ScenarioResponseMatcher,
  response: unknown
): ScenarioCheckResult {
  const type = 'responseMatcher';
  const value = readResponsePath(response, matcher.path);
  const failures: string[] = [];
  if (Object.hasOwn(matcher, 'equals') && !jsonSubsetMatches(matcher.equals, value)) {
    failures.push('equals');
  }
  if (matcher.regex !== undefined) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    if (!new RegExp(matcher.regex, 'u').test(text)) failures.push('regex');
  }
  if (matcher.includes !== undefined) {
    const includes = Array.isArray(value)
      ? value.includes(matcher.includes)
      : typeof value === 'string' && value.includes(matcher.includes);
    if (!includes) failures.push('includes');
  }
  if (value === undefined && failures.length === 0) failures.push('present');
  return result(
    type,
    failures.length === 0,
    failures.length === 0
      ? `${matcher.path} matched`
      : `${matcher.path} failed: ${failures.join(', ')}`
  );
}

/** expectedOps / forbiddenOps (scoped to the turn's seq window) and responseMatchers. */
export function evaluateTurnChecks(
  checks: ScenarioTurnChecks | undefined,
  log: ScenarioSideEffectLog,
  window: ScenarioSeqWindow,
  response: unknown
): ScenarioCheckResult[] {
  if (!checks) return [];
  const results: ScenarioCheckResult[] = [];
  for (const op of checks.expectedOps ?? []) {
    const count = calledOpRecords(log, op, window).length;
    results.push(result('expectedOp', count > 0, `${op} called ${count} time(s) in this turn`));
  }
  for (const op of checks.forbiddenOps ?? []) {
    const count = calledOpRecords(log, op, window).length;
    results.push(result('forbiddenOp', count === 0, `${op} called ${count} time(s) in this turn`));
  }
  for (const matcher of checks.responseMatchers ?? []) {
    results.push(evaluateResponseMatcher(matcher, response));
  }
  return results;
}
