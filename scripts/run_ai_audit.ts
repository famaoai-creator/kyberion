#!/usr/bin/env node
/**
 * AI Audit Test Layer runner (KC-05, KIMI_CLI_ADOPTION_PLAN 2026-07-20).
 *
 * One markdown file under tests_ai/ = one natural-language semantic invariant
 * (Scope = files to examine, Requirements = what must hold). This runner:
 *   1. enumerates tests_ai/*.md,
 *   2. fans each invariant out to the reasoning backend (delegateStructured)
 *      with bounded concurrency,
 *   3. aggregates report.json ({file, name, cases:[{name, pass, reason?}]})
 *      under active/shared/tmp/ai-audit/ together with a persisted Trace,
 *   4. renders pass/fail and exits non-zero when any case fails.
 *
 * Stub backend policy: when the resolved reasoning backend is the
 * deterministic stub, the run SKIPS with an explicit report — it never
 * fake-passes. The audit callable is injectable (options.auditFn) so the
 * fail path is provable in hermetic unit tests without a live LLM.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createStandardYargs,
  delegateStructured,
  finalizeAndPersist,
  getInstalledReasoningMode,
  getReasoningBackend,
  installReasoningBackends,
  logger,
  pathResolver,
  safeExistsSync,
  safeLstat,
  safeReadFile,
  safeReaddir,
  safeWriteFile,
  TraceContext,
} from '@agent/core';

export const AI_AUDIT_CASES_SCHEMA = z.object({
  cases: z
    .array(
      z.object({
        name: z.string().min(1),
        pass: z.boolean(),
        reason: z.string().optional(),
      })
    )
    .min(1),
});

export type AiAuditCases = z.infer<typeof AI_AUDIT_CASES_SCHEMA>;
export type AiAuditCase = AiAuditCases['cases'][number];

export interface AiAuditInvariant {
  /** Markdown path, repo-relative when under the repo root. */
  file: string;
  /** Invariant name from the first `#` heading (without the Invariant: prefix). */
  name: string;
  /** Scope entries (backticked paths in the `## Scope` section; basename globs allowed). */
  scope: string[];
  /** Full markdown body, handed verbatim to the auditor. */
  body: string;
}

export interface ScopedFile {
  path: string;
  content: string;
  truncated: boolean;
}

export interface AiAuditInvariantResult {
  file: string;
  name: string;
  cases: AiAuditCase[];
}

export interface AiAuditReport {
  run_id: string;
  generated_at: string;
  status: 'passed' | 'failed' | 'skipped';
  backend_mode: string | null;
  skip_reason: string | null;
  invariants: number;
  summary: { total_cases: number; failed_cases: number };
  results: AiAuditInvariantResult[];
  trace: { trace_id: string; trace_path: string | null };
}

export type AuditFn = (invariant: AiAuditInvariant, files: ScopedFile[]) => Promise<AiAuditCases>;

export interface RunAiAuditOptions {
  /** Invariants directory (default: tests_ai). Absolute or repo-relative. */
  invariantsDir?: string;
  /** Output directory for report.json + traces (default: active/shared/tmp/ai-audit). */
  outputDir?: string;
  /** Injectable audit decision function. When set, no reasoning backend is touched. */
  auditFn?: AuditFn;
  /** Parallel invariant audits (default 3). */
  concurrency?: number;
  /** Include the deliberately failing audit-layer self-test fixture. */
  includeSelfTestFixtures?: boolean;
}

export const SKIP_REASON_STUB_BACKEND = 'skipped: non-stub backend required';

const DEFAULT_INVARIANTS_DIR = 'tests_ai';
const DEFAULT_CONCURRENCY = 3;
const MAX_SCOPE_FILE_CHARS = 40_000;

function isSelfTestFixture(invariant: AiAuditInvariant): boolean {
  return (
    invariant.file.startsWith('tests_ai/fixture-') ||
    invariant.scope.some(
      (entry) => entry === 'tests_ai/fixtures' || entry.startsWith('tests_ai/fixtures/')
    )
  );
}

function resolveFromRoot(target: string, label = 'path'): string {
  const candidate = path.resolve(pathResolver.rootResolve(target));
  const relative = path.relative(pathResolver.rootDir(), candidate);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(
      `[POLICY_VIOLATION] AI audit ${label} must remain under the repository root: ${target}`
    );
  }
  return candidate;
}

/** Reject symlinked scope paths so a repo-relative entry cannot escape the VFS. */
function assertNoSymlinkPath(absolute: string): void {
  const relative = path.relative(pathResolver.rootDir(), absolute);
  let current = pathResolver.rootDir();
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (safeExistsSync(current) && safeLstat(current).isSymbolicLink()) {
      throw new Error(
        `[POLICY_VIOLATION] AI audit scope cannot traverse a symbolic link: ${repoRelative(absolute)}`
      );
    }
  }
}

function repoRelative(absolute: string): string {
  const relative = path.relative(pathResolver.rootDir(), absolute);
  return relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : absolute;
}

/** Extract the body of a `## <heading>` section (up to the next `##`). */
export function extractSection(content: string, heading: string): string {
  const lines = content.split('\n');
  const collected: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      inSection = match[1].toLowerCase().startsWith(heading.toLowerCase());
      continue;
    }
    if (inSection) collected.push(line);
  }
  return collected.join('\n');
}

export function parseInvariantMarkdown(file: string, content: string): AiAuditInvariant {
  const heading = content.match(/^#\s+(.+?)\s*$/m);
  const name = (heading ? heading[1] : path.basename(file, '.md'))
    .replace(/^invariant:\s*/i, '')
    .trim();
  const scope: string[] = [];
  for (const match of extractSection(content, 'Scope').matchAll(/`([^`]+)`/g)) {
    const entry = match[1].trim();
    if (entry) scope.push(entry);
  }
  return { file, name, scope, body: content };
}

/** List tests_ai/*.md invariants (README excluded), sorted for determinism. */
export function enumerateInvariants(
  invariantsDir: string = DEFAULT_INVARIANTS_DIR
): AiAuditInvariant[] {
  const absoluteDir = resolveFromRoot(invariantsDir);
  if (!safeExistsSync(absoluteDir)) {
    throw new Error(
      `[ai-audit] invariants directory not found: ${invariantsDir}. ` +
        'Create tests_ai/*.md (format: tests_ai/README.ja.md) before running pnpm ai-test.'
    );
  }
  return safeReaddir(absoluteDir)
    .filter((entry) => entry.endsWith('.md') && !/^readme/i.test(entry))
    .sort()
    .map((entry) => {
      const absolute = path.join(absoluteDir, entry);
      const content = safeReadFile(absolute, { encoding: 'utf8' }) as string;
      return parseInvariantMarkdown(repoRelative(absolute), content);
    });
}

/**
 * Resolve scope entries to concrete files. A `*` in the basename expands
 * within that single directory; missing entries are returned separately so
 * the runner can report them as deterministic failures (scope drift must
 * never silently shrink an audit).
 */
export function resolveScopeFiles(scope: string[]): {
  files: ScopedFile[];
  missing: string[];
} {
  const files: ScopedFile[] = [];
  const missing: string[] = [];

  const readScoped = (absolute: string): void => {
    assertNoSymlinkPath(absolute);
    const raw = safeReadFile(absolute, { encoding: 'utf8' }) as string;
    const truncated = raw.length > MAX_SCOPE_FILE_CHARS;
    files.push({
      path: repoRelative(absolute),
      content: truncated ? raw.slice(0, MAX_SCOPE_FILE_CHARS) : raw,
      truncated,
    });
  };

  for (const entry of scope) {
    if (entry.includes('*')) {
      const absoluteDir = resolveFromRoot(path.dirname(entry));
      const pattern = new RegExp(
        `^${path
          .basename(entry)
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[^/]*')}$`
      );
      const matches = safeExistsSync(absoluteDir)
        ? safeReaddir(absoluteDir)
            .filter((name) => pattern.test(name))
            .sort()
        : [];
      if (matches.length === 0) {
        missing.push(entry);
        continue;
      }
      for (const name of matches) readScoped(path.join(absoluteDir, name));
      continue;
    }
    const absolute = resolveFromRoot(entry);
    if (!safeExistsSync(absolute)) {
      missing.push(entry);
      continue;
    }
    readScoped(absolute);
  }
  return { files, missing };
}

export function buildAuditPrompt(invariant: AiAuditInvariant, files: ScopedFile[]): string {
  const sections = files.map(
    (file) =>
      `### ${file.path}${file.truncated ? ' (truncated)' : ''}\n\`\`\`\n${file.content}\n\`\`\``
  );
  return [
    'You are a strict code auditor. Audit the files below against ONE semantic invariant.',
    'The invariant is defined in markdown (Scope / Requirements / Examples):',
    '<<<INVARIANT',
    invariant.body,
    'INVARIANT>>>',
    '',
    'Files under audit:',
    ...sections,
    '',
    'Produce one case per (file, requirement) pair you evaluated.',
    'Name each case "<file> :: <short requirement summary>".',
    'Set pass=false ONLY for a concrete violation, and cite the offending code in reason.',
    'Set pass=true when the requirement holds; do not invent violations.',
  ].join('\n');
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Resolve the reasoning backend, short-circuiting on explicit stub mode so
 * stub-env runs (and hermetic tests) never touch provider discovery.
 */
export function detectBackendMode(): { mode: string | null; nonStub: boolean } {
  if (process.env.KYBERION_REASONING_BACKEND === 'stub') {
    return { mode: 'stub', nonStub: false };
  }
  const nonStub = installReasoningBackends();
  return { mode: getInstalledReasoningMode(), nonStub };
}

function buildRealAuditFn(): AuditFn {
  return (invariant, files) =>
    delegateStructured(
      getReasoningBackend(),
      buildAuditPrompt(invariant, files),
      AI_AUDIT_CASES_SCHEMA,
      { context: `ai-audit:${invariant.file}`, maxRetries: 2 }
    );
}

async function auditInvariant(
  invariant: AiAuditInvariant,
  auditFn: AuditFn,
  trace: TraceContext
): Promise<AiAuditInvariantResult> {
  // Events only (no child spans): parallel audits would interleave the
  // TraceContext span stack and pop each other's spans.
  trace.addEvent('ai-audit.invariant_start', { file: invariant.file, name: invariant.name });
  const cases: AiAuditCase[] = [];
  try {
    const { files, missing } = resolveScopeFiles(invariant.scope);
    // Deterministic pre-checks — no LLM involved.
    for (const entry of missing) {
      cases.push({
        name: `${invariant.file} :: scope resolves (${entry})`,
        pass: false,
        reason: `scope entry not found: ${entry}. Fix the Scope section or restore the file.`,
      });
    }
    if (invariant.scope.length === 0) {
      cases.push({
        name: `${invariant.file} :: has a non-empty Scope section`,
        pass: false,
        reason: 'no backticked paths found under "## Scope" — nothing would be audited.',
      });
    }
    if (files.length > 0) {
      const decision = AI_AUDIT_CASES_SCHEMA.parse(await auditFn(invariant, files));
      cases.push(...decision.cases);
    }
    const failed = cases.filter((item) => !item.pass).length;
    trace.addEvent('ai-audit.invariant_done', {
      file: invariant.file,
      cases: cases.length,
      failed,
    });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    // An audit that could not run is a failure, never a silent pass.
    cases.push({
      name: `${invariant.file} :: audit executed`,
      pass: false,
      reason: `audit error: ${message}`,
    });
    trace.addEvent('ai-audit.invariant_error', { file: invariant.file, error: message });
  }
  return { file: invariant.file, name: invariant.name, cases };
}

export async function runAiAudit(options: RunAiAuditOptions = {}): Promise<{
  report: AiAuditReport;
  reportPath: string;
  exitCode: number;
}> {
  const outputDir = options.outputDir
    ? resolveFromRoot(options.outputDir)
    : pathResolver.sharedTmp('ai-audit');
  const reportPath = path.join(outputDir, 'report.json');
  const runId = `ai-audit-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const trace = new TraceContext('ai-audit', { correlationId: runId });

  const enumerated = enumerateInvariants(options.invariantsDir);
  const invariants = options.includeSelfTestFixtures
    ? enumerated
    : enumerated.filter((invariant) => !isSelfTestFixture(invariant));
  trace.addEvent('ai-audit.enumerated', { invariants: invariants.length });

  let auditFn = options.auditFn;
  let backendMode: string | null = null;
  let skipReason: string | null = null;

  if (!auditFn) {
    const detected = detectBackendMode();
    backendMode = detected.mode;
    if (!detected.nonStub || detected.mode === 'stub' || detected.mode === null) {
      skipReason = `${SKIP_REASON_STUB_BACKEND} (resolved mode: ${detected.mode ?? 'none'})`;
    } else {
      auditFn = buildRealAuditFn();
    }
  } else {
    backendMode = 'injected';
  }

  let results: AiAuditInvariantResult[] = [];
  if (skipReason) {
    trace.addEvent('ai-audit.skipped', { reason: skipReason });
    logger.warn(`[ai-audit] ${skipReason}`);
  } else {
    results = await mapWithConcurrency(
      invariants,
      options.concurrency ?? DEFAULT_CONCURRENCY,
      (invariant) => auditInvariant(invariant, auditFn!, trace)
    );
  }

  const allCases = results.flatMap((result) => result.cases);
  const failedCases = allCases.filter((item) => !item.pass).length;
  const status: AiAuditReport['status'] = skipReason
    ? 'skipped'
    : failedCases > 0
      ? 'failed'
      : 'passed';

  trace.addArtifact('file', reportPath, 'ai-audit aggregated report');
  const persisted = finalizeAndPersist(trace, { dir: path.join(outputDir, 'traces') });

  const report: AiAuditReport = {
    run_id: runId,
    generated_at: new Date().toISOString(),
    status,
    backend_mode: backendMode,
    skip_reason: skipReason,
    invariants: invariants.length,
    summary: { total_cases: allCases.length, failed_cases: failedCases },
    results,
    trace: { trace_id: trace.traceId, trace_path: persisted.path },
  };
  safeWriteFile(reportPath, JSON.stringify(report, null, 2));

  return { report, reportPath, exitCode: status === 'failed' ? 1 : status === 'skipped' ? 2 : 0 };
}

export function renderReport(report: AiAuditReport, reportPath: string): string {
  const lines: string[] = [];
  if (report.status === 'skipped') {
    lines.push(`SKIP ai-audit — ${report.skip_reason}`);
  }
  for (const result of report.results) {
    const failed = result.cases.filter((item) => !item.pass);
    lines.push(`${failed.length > 0 ? 'FAIL' : 'PASS'} ${result.file} — ${result.name}`);
    for (const item of failed) {
      lines.push(`  ✗ ${item.name}${item.reason ? ` — ${item.reason}` : ''}`);
    }
  }
  lines.push(
    `[ai-audit] status=${report.status} invariants=${report.invariants} ` +
      `cases=${report.summary.total_cases} failed=${report.summary.failed_cases} ` +
      `report=${reportPath} trace=${report.trace.trace_id}`
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('dir', { type: 'string', describe: 'Invariants directory (default: tests_ai)' })
    .option('json', { type: 'boolean', default: false, describe: 'Print the raw report JSON' })
    .option('concurrency', { type: 'number', describe: 'Parallel invariant audits (default: 3)' })
    .parseSync();

  const { report, reportPath, exitCode } = await runAiAudit({
    invariantsDir: argv.dir,
    outputDir: argv.out,
    concurrency: argv.concurrency,
  });

  if (argv.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReport(report, reportPath));
  }
  process.exitCode = exitCode;
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error(`[ai-audit] fatal: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
