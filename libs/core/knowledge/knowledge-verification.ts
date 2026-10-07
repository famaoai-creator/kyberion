/**
 * Knowledge verification ledger: when a document last worked.
 *
 * A procedure that keeps working does not need updating, and a document's
 * age alone says nothing about whether it is still right. What matters is
 * whether the current text has led to a successful run. This ledger records,
 * per tenant and per document, the last successful run that used it (with a
 * fingerprint of the text at that time) and the last explicit problem report.
 * From that, a document is in one of these states:
 *
 * - `verified` — the current text has a successful run and no later problem.
 * - `changed_since_verified` — it worked before, but the text has changed
 *   since; the new text has not been through a successful run yet.
 * - `reported_problem` — a person marked it wrong or stale after its last
 *   successful run.
 * - no state — never recorded; treated like any other document.
 *
 * Evidence is deliberately conservative: a success is only recorded when a
 * worker reported using the document and finished without gaps or open
 * needs, and a problem only comes from explicit `wrong` / `stale` feedback —
 * a failed task is not blamed on the documents it read.
 *
 * The ledger is tenant-level, like the usage aggregate: runs happen at
 * mission/task scope but every reader asks per tenant. Public work without a
 * tenant uses the unpartitioned ledger.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { getRegisteredEnvText } from '../foundation/env.js';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { nowIso } from '../foundation/time.js';
import { logger } from '../core.js';
import { pathResolver } from '../path-resolver.js';
import { physicalScopedPath } from '../physical-namespace.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
} from '../secure-io.js';
import type { ScopeContext } from '../scope-context.js';

export type KnowledgeVerificationState = 'verified' | 'changed_since_verified' | 'reported_problem';

/**
 * What a success rests on: a golden-scenario check of the run's own evidence
 * (`golden`), or a worker reporting it used the document in a finished task
 * (`worker_report`). A golden check is the stronger of the two.
 */
export type KnowledgeVerificationEvidence = 'golden' | 'worker_report';

/** `failed_check`: a golden-scenario check of a run failed. */
export type KnowledgeProblemKind = 'wrong' | 'stale' | 'failed_check';

export interface KnowledgeVerificationEntry {
  document_path: string;
  last_success_at?: string;
  /** Fingerprint of the document text at the last successful run. */
  last_success_fingerprint?: string;
  /** Project of the last successful run, when it had one. */
  last_success_project_id?: string;
  /** Absent on entries written before evidence was recorded: a worker report. */
  last_success_evidence?: KnowledgeVerificationEvidence;
  success_count: number;
  last_problem_at?: string;
  last_problem_kind?: KnowledgeProblemKind;
  last_problem_reason?: string;
}

export interface KnowledgeVerification {
  state: KnowledgeVerificationState;
  last_success_at?: string;
  evidence?: KnowledgeVerificationEvidence;
  last_problem_at?: string;
  last_problem_kind?: KnowledgeProblemKind;
}

const LEDGER_FILE = 'knowledge-verification.json';
const MAX_ENTRIES = 5000;

function ledgerPath(scope?: ScopeContext): string {
  const override = getRegisteredEnvText('KYBERION_KNOWLEDGE_FEEDBACK_DIR')?.trim();
  const base = override
    ? pathResolver.rootResolve(override)
    : pathResolver.shared('runtime/feedback-loop');
  const relativeBase = path.relative(pathResolver.rootDir(), base).replace(/\\/g, '/');
  const tenant = scope?.tenant_slug?.trim();
  const directory = tenant
    ? physicalScopedPath(relativeBase, { tier: scope?.tier ?? 'confidential', tenant_slug: tenant })
    : relativeBase;
  return assertSafeRepositoryPath(
    pathResolver.rootResolve(path.posix.join(directory, LEDGER_FILE)),
    {
      allowMissingLeaf: true,
    }
  );
}

/** Test/observability seam: where this scope's ledger lives. */
export function knowledgeVerificationLedgerPath(scope?: ScopeContext): string {
  return ledgerPath(scope);
}

function loadLedger(scope?: ScopeContext): KnowledgeVerificationEntry[] {
  const filePath = ledgerPath(scope);
  if (safeExistsSync(filePath) && !safeLstat(filePath).isFile()) return [];
  try {
    const parsed = readJsonIfPresent<unknown>(filePath);
    return Array.isArray(parsed) ? (parsed as KnowledgeVerificationEntry[]) : [];
  } catch {
    return [];
  }
}

function saveLedger(entries: KnowledgeVerificationEntry[], scope?: ScopeContext): void {
  const filePath = ledgerPath(scope);
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  writeJson(filePath, entries.slice(-MAX_ENTRIES));
}

/**
 * Short fingerprint of a repository document's current text, or undefined
 * when the path escapes the repository or is not a regular file.
 */
export function knowledgeDocumentFingerprint(
  documentPath: string,
  rootDir?: string
): string | undefined {
  const normalized = documentPath.replace(/\\/g, '/');
  if (!normalized || path.posix.isAbsolute(normalized)) return undefined;
  if (normalized.split('/').includes('..')) return undefined;
  try {
    // Only a hash of the text is kept, never the text itself.
    const absolute = assertSafeRepositoryPath(
      rootDir ? path.join(rootDir, normalized) : pathResolver.rootResolve(normalized)
    );
    if (!safeExistsSync(absolute) || !safeLstat(absolute).isFile()) return undefined;
    const text = String(safeReadFile(absolute, { encoding: 'utf8' }));
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
  } catch {
    return undefined;
  }
}

function upsert(
  entries: KnowledgeVerificationEntry[],
  documentPath: string
): KnowledgeVerificationEntry {
  let entry = entries.find((candidate) => candidate.document_path === documentPath);
  if (!entry) {
    entry = { document_path: documentPath, success_count: 0 };
    entries.push(entry);
  }
  return entry;
}

/**
 * Record that a run using these documents finished successfully. Fails open:
 * verification is telemetry and never blocks the task it describes.
 */
export function recordKnowledgeVerifiedRun(input: {
  documentPaths: string[];
  scope?: ScopeContext;
  projectId?: string;
  /** Defaults to `worker_report`. */
  evidence?: KnowledgeVerificationEvidence;
  at?: string;
  rootDir?: string;
}): void {
  const paths = [...new Set(input.documentPaths.map((p) => p.trim()).filter(Boolean))];
  if (paths.length === 0) return;
  try {
    const entries = loadLedger(input.scope);
    const at = input.at ?? nowIso();
    for (const documentPath of paths) {
      const fingerprint = knowledgeDocumentFingerprint(documentPath, input.rootDir);
      if (!fingerprint) continue;
      const entry = upsert(entries, documentPath);
      entry.last_success_at = at;
      entry.last_success_fingerprint = fingerprint;
      if (input.projectId) entry.last_success_project_id = input.projectId;
      else delete entry.last_success_project_id;
      entry.last_success_evidence = input.evidence ?? 'worker_report';
      entry.success_count += 1;
    }
    saveLedger(entries, input.scope);
  } catch (error) {
    logger.warn(
      `[knowledge-verification] verified run not recorded — ${
        error instanceof Error ? error.message : String(error)
      } | next: check the feedback-loop runtime directory`
    );
  }
}

/** Record an explicit `wrong` / `stale` report, or a failed golden check, against a document. */
export function recordKnowledgeProblem(input: {
  documentPath: string;
  kind: KnowledgeProblemKind;
  reason?: string;
  scope?: ScopeContext;
  at?: string;
}): void {
  const documentPath = input.documentPath.trim();
  if (!documentPath) return;
  try {
    const entries = loadLedger(input.scope);
    const entry = upsert(entries, documentPath);
    entry.last_problem_at = input.at ?? nowIso();
    entry.last_problem_kind = input.kind;
    if (input.reason?.trim()) entry.last_problem_reason = input.reason.trim().slice(0, 300);
    else delete entry.last_problem_reason;
    saveLedger(entries, input.scope);
  } catch (error) {
    logger.warn(
      `[knowledge-verification] problem report not recorded — ${
        error instanceof Error ? error.message : String(error)
      } | next: check the feedback-loop runtime directory`
    );
  }
}

function stateOf(
  entry: KnowledgeVerificationEntry,
  currentFingerprint: string | undefined
): KnowledgeVerification | undefined {
  const problemAfterSuccess =
    entry.last_problem_at &&
    (!entry.last_success_at || entry.last_problem_at > entry.last_success_at);
  if (problemAfterSuccess) {
    return {
      state: 'reported_problem',
      ...(entry.last_success_at ? { last_success_at: entry.last_success_at } : {}),
      last_problem_at: entry.last_problem_at,
      ...(entry.last_problem_kind ? { last_problem_kind: entry.last_problem_kind } : {}),
    };
  }
  if (!entry.last_success_at || !entry.last_success_fingerprint || !currentFingerprint) {
    return undefined;
  }
  return {
    state:
      entry.last_success_fingerprint === currentFingerprint ? 'verified' : 'changed_since_verified',
    last_success_at: entry.last_success_at,
    evidence: entry.last_success_evidence ?? 'worker_report',
  };
}

/** Resolve the verification state of each document for this scope. */
export function resolveKnowledgeVerification(
  documentPaths: string[],
  scope?: ScopeContext,
  rootDir?: string
): Map<string, KnowledgeVerification> {
  const out = new Map<string, KnowledgeVerification>();
  if (documentPaths.length === 0) return out;
  const entries = new Map(loadLedger(scope).map((entry) => [entry.document_path, entry]));
  for (const documentPath of documentPaths) {
    const entry = entries.get(documentPath);
    if (!entry) continue;
    const resolved = stateOf(entry, knowledgeDocumentFingerprint(documentPath, rootDir));
    if (resolved) out.set(documentPath, resolved);
  }
  return out;
}

/**
 * Documents this scope relied on that changed since they last worked: the
 * mechanical "procedure update" notice. Limited to runs of the same project
 * (or project-less runs for a project-less caller), most recently verified
 * first.
 */
export function findChangedSinceVerified(input: {
  scope?: ScopeContext;
  projectId?: string;
  limit: number;
  rootDir?: string;
}): Array<{ document_path: string; last_success_at: string }> {
  if (input.limit <= 0) return [];
  return (
    loadLedger(input.scope)
      // Same project only; a project-less caller only sees project-less runs,
      // so one project's procedures never surface in another's packs.
      .filter((entry) => (entry.last_success_project_id ?? '') === (input.projectId ?? ''))
      .map((entry) => ({
        entry,
        resolved: stateOf(entry, knowledgeDocumentFingerprint(entry.document_path, input.rootDir)),
      }))
      .filter(({ resolved }) => resolved?.state === 'changed_since_verified')
      .sort((a, b) => (b.entry.last_success_at ?? '').localeCompare(a.entry.last_success_at ?? ''))
      .slice(0, input.limit)
      .map(({ entry }) => ({
        document_path: entry.document_path,
        last_success_at: entry.last_success_at as string,
      }))
  );
}

/** One-line label a worker reads next to a knowledge hint. */
export function formatKnowledgeVerificationLabel(verification?: KnowledgeVerification): string {
  if (!verification) return '';
  const day = (iso?: string) => (iso ? iso.slice(0, 10) : 'unknown');
  switch (verification.state) {
    case 'verified':
      return verification.evidence === 'golden'
        ? ` [passed its success check in a run on ${day(verification.last_success_at)}]`
        : ` [worked in a run on ${day(verification.last_success_at)}]`;
    case 'changed_since_verified':
      return ` [changed since it last worked (${day(verification.last_success_at)}) — not yet confirmed; check the steps you rely on]`;
    case 'reported_problem':
      return verification.last_problem_kind === 'failed_check'
        ? ` [failed its success check in a run on ${day(verification.last_problem_at)} — verify before relying on it]`
        : ` [reported ${verification.last_problem_kind ?? 'wrong'} on ${day(verification.last_problem_at)} — verify before relying on it]`;
  }
}
