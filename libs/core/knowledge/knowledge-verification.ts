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
import { withLockSync } from '../foundation/lock-utils.js';
import { validKnowledgeDeliverySnapshot } from './knowledge-delivery-snapshot.js';
import type { DeliveredKnowledgeRef } from './knowledge-feedback-loop.js';
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
import { assertMemoryScope, type MemoryScopeEnvelope } from './memory-scope.js';
import {
  summarizeKnowledgeReuse,
  validKnowledgeReuseReceipt,
  type KnowledgeReuseReceipt,
  type KnowledgeReuseSummary,
} from './knowledge-reuse-contract.js';

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
  /** Bounded observations, versioned by the bytes actually delivered. */
  reuse_receipts?: KnowledgeReuseReceipt[];
  last_success_at?: string;
  /** Fingerprint of the document text at the last successful run. */
  last_success_fingerprint?: string;
  last_success_snapshot_sha256?: string;
  last_success_delivery_id?: string;
  last_success_scope_context?: ScopeContext;
  /** Result replay protection, scoped to this document. */
  success_receipt_ids?: string[];
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
  if (scope?.tier === 'personal') {
    const canonical = assertMemoryScope(scope as MemoryScopeEnvelope);
    if (!canonical.owner_nhi)
      throw new Error(
        '[KNOWLEDGE_REUSE_OWNER_REQUIRED] Personal verification needs an explicit owner'
      );
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    return assertSafeRepositoryPath(
      pathResolver.rootResolve(
        path.posix.join(
          'active/personal/owners',
          hash(canonical.owner_nhi),
          'feedback-loop',
          hash(JSON.stringify(canonical)),
          LEDGER_FILE
        )
      ),
      { allowMissingLeaf: true }
    );
  }
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

function loadLedger(scope?: ScopeContext, strict = false): KnowledgeVerificationEntry[] {
  const filePath = ledgerPath(scope);
  if (safeExistsSync(filePath) && !safeLstat(filePath).isFile()) {
    if (strict) throw new Error('[KNOWLEDGE_REUSE] Ledger must be a regular file');
    return [];
  }
  try {
    const parsed = readJsonIfPresent<unknown>(filePath);
    if (strict && safeExistsSync(filePath) && !Array.isArray(parsed))
      throw new Error('[KNOWLEDGE_REUSE] Invalid ledger');
    return Array.isArray(parsed) ? (parsed as KnowledgeVerificationEntry[]) : [];
  } catch (error) {
    if (strict) throw error;
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

/** Append a revision observation to the existing verification ledger, not another store. */
export function recordKnowledgeReuseObservation(input: {
  documentSnapshots: DeliveredKnowledgeRef[];
  receiptId: string;
  kind: KnowledgeReuseReceipt['kind'];
  scope?: ScopeContext;
  humanIntervention?: boolean;
  at?: string;
}): void {
  if (!/^[a-f0-9]{64}$/.test(input.receiptId)) return;
  const scope = input.scope ? assertMemoryScope(input.scope) : undefined;
  try {
    withLockSync('knowledge-verification:' + ledgerPath(scope), () => {
      const entries = loadLedger(scope);
      for (const ref of input.documentSnapshots) {
        if (!validKnowledgeDeliverySnapshot(ref.snapshot) || !ref.snapshot.source_sha256) continue;
        const receipt: KnowledgeReuseReceipt = {
          receipt_id: input.receiptId,
          source_sha256: ref.snapshot.source_sha256,
          kind: input.kind,
          ...(scope ? { scope } : {}),
          at: input.at ?? nowIso(),
          ...(input.humanIntervention !== undefined
            ? { human_intervention: input.humanIntervention }
            : {}),
        };
        if (!validKnowledgeReuseReceipt(receipt)) continue;
        const entry = upsert(entries, ref.path);
        const previous = (entry.reuse_receipts || []).filter(validKnowledgeReuseReceipt);
        if (
          previous.some(
            (row) =>
              row.receipt_id === receipt.receipt_id &&
              row.kind === receipt.kind &&
              row.source_sha256 === receipt.source_sha256
          )
        )
          continue;
        entry.reuse_receipts = [...previous, receipt].slice(-1000);
      }
      saveLedger(entries, scope);
    });
  } catch (error) {
    logger.warn(
      `[knowledge-reuse] observation not recorded — ${String(error)} | next: inspect feedback ledger`
    );
  }
}

/** Read only an explicitly selected scope and revision. Publication is not a successful run. */
export function inspectKnowledgeReuse(input: {
  documentPath: string;
  sourceSha256: string;
  scope?: ScopeContext;
}): KnowledgeReuseSummary {
  const scope = input.scope ? assertMemoryScope(input.scope) : undefined;
  if (!/^[a-f0-9]{64}$/.test(input.sourceSha256))
    throw new Error('[KNOWLEDGE_REUSE] Invalid revision digest');
  const entry = loadLedger(scope, true).find((row) => row.document_path === input.documentPath);
  if (entry?.reuse_receipts !== undefined && !Array.isArray(entry.reuse_receipts))
    throw new Error('[KNOWLEDGE_REUSE] Invalid receipt list');
  return summarizeKnowledgeReuse(entry?.reuse_receipts || [], input.sourceSha256, scope);
}

/**
 * Record that a run using these documents finished successfully. Fails open:
 * verification is telemetry and never blocks the task it describes.
 */
export function recordKnowledgeVerifiedRun(
  input: Parameters<typeof recordKnowledgeVerifiedRunUnlocked>[0]
): void {
  try {
    withLockSync('knowledge-verification:' + ledgerPath(input.scope), () =>
      recordKnowledgeVerifiedRunUnlocked(input)
    );
    // A worker report is explicitly weaker than an independent golden check.
    if (input.receiptId && input.documentSnapshots)
      recordKnowledgeReuseObservation({
        documentSnapshots: input.documentSnapshots,
        receiptId: input.receiptId,
        kind: input.evidence === 'golden' ? 'verified' : 'worker_report_complete',
        scope: input.scope,
        at: input.at,
      });
  } catch (error) {
    logger.warn(
      '[knowledge-verification] receipt lock unavailable — ' +
        String(error) +
        ' | next: inspect feedback storage'
    );
  }
}

function recordKnowledgeVerifiedRunUnlocked(input: {
  documentPaths?: string[];
  /** Supplied by task delivery receipts. Never re-read their mutable paths. */
  documentSnapshots?: DeliveredKnowledgeRef[];
  receiptId?: string;
  scope?: ScopeContext;
  projectId?: string;
  /** Defaults to `worker_report`. */
  evidence?: KnowledgeVerificationEvidence;
  at?: string;
  rootDir?: string;
}): void {
  const paths = [
    ...new Set(
      (input.documentSnapshots?.map((ref) => ref.path) || input.documentPaths || [])
        .map((p) => p.trim())
        .filter(Boolean)
    ),
  ];
  if (paths.length === 0) return;
  try {
    const entries = loadLedger(input.scope);
    const at = input.at ?? nowIso();
    for (const documentPath of paths) {
      const delivered = input.documentSnapshots?.find((ref) => ref.path === documentPath);
      const snapshot = delivered?.snapshot;
      const fingerprint = input.documentSnapshots
        ? validKnowledgeDeliverySnapshot(snapshot)
          ? snapshot.source_sha256?.slice(0, 16)
          : undefined
        : knowledgeDocumentFingerprint(documentPath, input.rootDir);
      if (!fingerprint) continue;
      const entry = upsert(entries, documentPath);
      if (input.receiptId && entry.success_receipt_ids?.includes(input.receiptId)) continue;
      if (input.receiptId)
        entry.success_receipt_ids = [...(entry.success_receipt_ids || []), input.receiptId].slice(
          -1000
        );
      if (snapshot) entry.last_success_snapshot_sha256 = snapshot.sha256;
      else delete entry.last_success_snapshot_sha256;
      if (delivered?.delivery_id) entry.last_success_delivery_id = delivered.delivery_id;
      else delete entry.last_success_delivery_id;
      if (input.scope) entry.last_success_scope_context = { ...input.scope };
      else delete entry.last_success_scope_context;
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
  rootDir?: string,
  sourceFingerprints?: ReadonlyMap<string, string | undefined>
): Map<string, KnowledgeVerification> {
  const out = new Map<string, KnowledgeVerification>();
  if (documentPaths.length === 0) return out;
  const entries = new Map(loadLedger(scope).map((entry) => [entry.document_path, entry]));
  for (const documentPath of documentPaths) {
    const entry = entries.get(documentPath);
    if (!entry) continue;
    const resolved = stateOf(
      entry,
      sourceFingerprints
        ? sourceFingerprints.get(documentPath)
        : knowledgeDocumentFingerprint(documentPath, rootDir)
    );
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
        : ` [worker reported use in a completed run on ${day(verification.last_success_at)}; not an independent success check]`;
    case 'changed_since_verified':
      return ` [changed since the recorded run (${day(verification.last_success_at)}) — not yet confirmed; check the steps you rely on]`;
    case 'reported_problem':
      return verification.last_problem_kind === 'failed_check'
        ? ` [failed its success check in a run on ${day(verification.last_problem_at)} — verify before relying on it]`
        : ` [reported ${verification.last_problem_kind ?? 'wrong'} on ${day(verification.last_problem_at)} — verify before relying on it]`;
  }
}
