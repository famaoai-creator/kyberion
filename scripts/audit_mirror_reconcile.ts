/**
 * SA-01: reconcile customer stance audit mirrors against the master chain.
 *
 * The master chain is authoritative. A stale mirror is never deleted: it is
 * moved to the governed recoverable archive, and a mirror is rebuilt only when
 * the master still contains entries for that tenant. The operation is dry-run
 * by default and requires an authenticated Sovereign approval to apply.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { auditChain, normalizePersistedAuditEntry } from '@agent/core/audit-chain';
import {
  computeApprovalPayloadHash,
  createApprovalRequest,
  listApprovalRequests,
  loadApprovalRequest,
  validateHumanFinalDecision,
  type ApprovalRequestRecord,
} from '@agent/core/approval-store';
import { missionEvidenceDir, pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeMoveSync,
  safeReaddir,
  safeLstat,
  safeWriteFile,
} from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/governance';
import type { AuditEntry } from '@agent/core/audit-chain';
import { nowIso, parseSafeJsonInput, readTextFile } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export const AUDIT_MIRROR_APPROVAL_CHANNEL = 'terminal';
export const AUDIT_MIRROR_EFFECT_BINDING = 'sa-01:audit-mirror-reconcile';
export const DEFAULT_AUDIT_MIRROR_MISSION = 'MSN-SA-01-20260816A';
const AUDIT_MIRROR_USAGE =
  'Usage: pnpm kyberion audit mirror-reconcile [--mission-id <id>] [--request-approval --requested-by <actor>] [--apply --approval-request-id <id>]';

const AUDIT_FILE_RE = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface AuditMirrorFinding {
  slug: string;
  path: string;
  mirror_count: number;
  master_count: number;
  mirror_fingerprint: string;
  master_fingerprint: string;
  reason: 'stale_mirror' | 'mirror_out_of_sync';
  action: 'quarantine' | 'quarantine_and_rebuild';
}

export interface AuditMirrorReceipt {
  mission_id: string;
  mode: 'dry-run' | 'apply';
  approved_by?: string;
  approval_request_id?: string;
  generated_at: string;
  findings: AuditMirrorFinding[];
  archived: Array<{ from: string; to: string }>;
  rebuilt: Array<{ slug: string; path: string; entries: number }>;
  receipt_path?: string;
}

export interface OpenAuditMirrorApprovalResult {
  missionId: string;
  created: boolean;
  requestId?: string;
  payloadHash?: string;
  findings: AuditMirrorFinding[];
  reason?: string;
}

function directories(root: string, rootDir = pathResolver.rootDir()): string[] {
  const safeRoot = assertSafeRepositoryPath(root, { allowMissingLeaf: true, rootDir });
  if (!safeExistsSync(safeRoot)) return [];
  return safeReaddir(safeRoot).filter((entry) => {
    try {
      return safeLstat(
        assertSafeRepositoryPath(path.join(safeRoot, entry), {
          allowMissingLeaf: true,
          rootDir,
        })
      ).isDirectory();
    } catch {
      return false;
    }
  });
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function entryFingerprint(entries: AuditEntry[]): string {
  return fingerprint(entries.map((entry) => ({ id: entry.id, currentHash: entry.currentHash })));
}

function parseMirrorFile(filePath: string, rootDir = pathResolver.rootDir()): AuditEntry[] {
  const safePath = assertSafeRepositoryPath(filePath, { rootDir });
  const raw = readTextFile(safePath);
  const entries: AuditEntry[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      entries.push(
        normalizePersistedAuditEntry(parseSafeJsonInput(line, `${safePath}:${index + 1}`))
      );
    } catch (error) {
      throw new Error(
        `[AUDIT_MIRROR_INVALID] ${safePath}:${index + 1} is not valid JSON: ${String(error)}`
      );
    }
  }
  return entries;
}

function loadMirrorEntries(mirrorDir: string, rootDir = pathResolver.rootDir()): AuditEntry[] {
  const safeMirrorDir = assertSafeRepositoryPath(mirrorDir, { rootDir });
  return safeReaddir(safeMirrorDir)
    .filter((fileName) => AUDIT_FILE_RE.test(fileName))
    .filter((fileName) => {
      try {
        return safeLstat(
          assertSafeRepositoryPath(path.join(safeMirrorDir, fileName), { rootDir })
        ).isFile();
      } catch {
        return false;
      }
    })
    .sort((left, right) => left.localeCompare(right))
    .flatMap((fileName) => parseMirrorFile(path.join(safeMirrorDir, fileName), rootDir));
}

function loadMasterEntries(rootDir: string): AuditEntry[] {
  if (path.resolve(rootDir) === path.resolve(pathResolver.rootDir())) {
    return auditChain.loadAll();
  }
  const auditDir = assertSafeRepositoryPath(
    path.join(rootDir, 'active', 'shared', 'logs', 'audit'),
    {
      allowMissingLeaf: true,
      rootDir,
    }
  );
  if (!safeExistsSync(auditDir)) return [];
  return safeReaddir(auditDir)
    .filter((fileName) => AUDIT_FILE_RE.test(fileName))
    .filter((fileName) => {
      try {
        return safeLstat(
          assertSafeRepositoryPath(path.join(auditDir, fileName), { rootDir })
        ).isFile();
      } catch {
        return false;
      }
    })
    .sort((left, right) => left.localeCompare(right))
    .flatMap((fileName) => parseMirrorFile(path.join(auditDir, fileName), rootDir));
}

function masterEntriesByTenant(rootDir = pathResolver.rootDir()): Map<string, AuditEntry[]> {
  const result = new Map<string, AuditEntry[]>();
  for (const entry of loadMasterEntries(rootDir)) {
    if (!entry.tenantSlug) continue;
    const entries = result.get(entry.tenantSlug) || [];
    entries.push(entry);
    result.set(entry.tenantSlug, entries);
  }
  return result;
}

/** Collect only mismatched existing mirrors; missing overlays are not created. */
export function collectAuditMirrorFindings(rootDir = pathResolver.rootDir()): AuditMirrorFinding[] {
  const customersRoot = assertSafeRepositoryPath(path.join(rootDir, 'customer'), {
    allowMissingLeaf: true,
    rootDir,
  });
  const masterByTenant = masterEntriesByTenant(rootDir);
  const findings: AuditMirrorFinding[] = [];

  for (const slug of directories(customersRoot, rootDir)) {
    const mirrorDir = assertSafeRepositoryPath(path.join(customersRoot, slug, 'logs', 'audit'), {
      allowMissingLeaf: true,
      rootDir,
    });
    if (!safeExistsSync(mirrorDir)) continue;
    const mirrorEntries = loadMirrorEntries(mirrorDir, rootDir);
    const masterEntries = masterByTenant.get(slug) || [];
    const same =
      mirrorEntries.length === masterEntries.length &&
      mirrorEntries.every(
        (entry, index) =>
          entry.id === masterEntries[index]?.id &&
          entry.currentHash === masterEntries[index]?.currentHash
      );
    if (same) continue;

    findings.push({
      slug,
      path: path.relative(rootDir, mirrorDir).replaceAll(path.sep, '/'),
      mirror_count: mirrorEntries.length,
      master_count: masterEntries.length,
      mirror_fingerprint: entryFingerprint(mirrorEntries),
      master_fingerprint: entryFingerprint(masterEntries),
      reason: masterEntries.length === 0 ? 'stale_mirror' : 'mirror_out_of_sync',
      action: masterEntries.length === 0 ? 'quarantine' : 'quarantine_and_rebuild',
    });
  }

  return findings.sort((left, right) => left.slug.localeCompare(right.slug));
}

export function buildAuditMirrorApprovalPayload(
  missionId: string,
  findings: AuditMirrorFinding[]
): Record<string, unknown> {
  return {
    mission_id: missionId.trim().toUpperCase(),
    findings: findings.map((finding) => ({ ...finding })),
    effect: AUDIT_MIRROR_EFFECT_BINDING,
  };
}

export function computeAuditMirrorApprovalPayloadHash(
  missionId: string,
  findings: AuditMirrorFinding[]
): string {
  return computeApprovalPayloadHash(buildAuditMirrorApprovalPayload(missionId, findings));
}

export function openAuditMirrorApproval(input: {
  missionId: string;
  requestedBy?: string;
  rootDir?: string;
}): OpenAuditMirrorApprovalResult {
  const missionId = input.missionId.trim().toUpperCase();
  const findings = collectAuditMirrorFindings(input.rootDir || pathResolver.rootDir());
  const payloadHash = computeAuditMirrorApprovalPayloadHash(missionId, findings);
  const existing = listApprovalRequests({
    storageChannels: [AUDIT_MIRROR_APPROVAL_CHANNEL],
    kind: 'mission_gate',
    status: 'pending',
  }).find((record) => record.source?.missionId?.toUpperCase() === missionId);

  if (existing) {
    if (existing.accountability?.payloadHash === payloadHash) {
      return { missionId, created: false, requestId: existing.id, payloadHash, findings };
    }
    return {
      missionId,
      created: false,
      requestId: existing.id,
      payloadHash,
      findings,
      reason: `A pending approval (${existing.id}) is bound to a different mirror findings set.`,
    };
  }

  const record = createApprovalRequest('mission_controller', {
    channel: AUDIT_MIRROR_APPROVAL_CHANNEL,
    storageChannel: AUDIT_MIRROR_APPROVAL_CHANNEL,
    threadTs: missionId,
    correlationId: `audit-mirror-reconcile-${missionId}`,
    requestedBy: input.requestedBy || 'audit-mirror-controller',
    kind: 'mission_gate',
    draft: {
      title: `SA-01 audit mirror reconciliation: ${missionId}`,
      summary: 'Approve quarantine of stale stance mirrors and rebuild from the master chain.',
      details: JSON.stringify(findings, null, 2),
      severity: 'high',
    },
    source: { missionId },
    requestedByContext: {
      surface: 'terminal',
      actorId: input.requestedBy || 'audit-mirror-controller',
      actorRole: 'mission_controller',
      missionId,
    },
    justification: {
      reason: 'SA-01 tenant audit mirrors no longer match the authoritative master chain.',
      impactSummary:
        'Only the existing customer/{slug}/logs/audit mirror is moved to recoverable archive; master audit records are retained.',
      requestedEffects: [AUDIT_MIRROR_EFFECT_BINDING],
    },
    risk: {
      level: 'critical',
      restartScope: 'manual',
      requiresStrongAuth: true,
      policyId: 'SA-01',
    },
    workflow: {
      workflowId: `sa-01-${missionId}`,
      mode: 'all_required',
      requiredRoles: ['sovereign'],
      stages: [],
      approvals: [{ role: 'sovereign', status: 'pending' }],
    },
    accountability: {
      finalDecision: 'human_only',
      payloadHash,
      effectBinding: AUDIT_MIRROR_EFFECT_BINDING,
    },
  });

  return { missionId, created: true, requestId: record.id, payloadHash, findings };
}

function assertAuditMirrorApproval(
  approvalRequestId: string,
  missionId: string,
  findings: AuditMirrorFinding[]
): ApprovalRequestRecord {
  const approval = loadApprovalRequest(AUDIT_MIRROR_APPROVAL_CHANNEL, approvalRequestId);
  const humanApproval = approval?.workflow?.approvals?.find(
    (entry) =>
      entry.status === 'approved' && entry.decidedByType === 'human' && entry.authenticated === true
  );
  if (!approval || approval.kind !== 'mission_gate' || approval.status !== 'approved') {
    throw new Error(
      `[POLICY_VIOLATION] SA-01 requires an approved mission_gate request: ${approvalRequestId}`
    );
  }
  if (approval.source?.missionId?.toUpperCase() !== missionId.trim().toUpperCase()) {
    throw new Error('[POLICY_VIOLATION] SA-01 approval is bound to a different mission');
  }
  if (approval.accountability?.effectBinding !== AUDIT_MIRROR_EFFECT_BINDING) {
    throw new Error('[POLICY_VIOLATION] SA-01 approval is not bound to the mirror effect');
  }
  if (
    approval.accountability?.payloadHash !==
    computeAuditMirrorApprovalPayloadHash(missionId, findings)
  ) {
    throw new Error('[POLICY_VIOLATION] SA-01 approval is bound to a different findings set');
  }
  if (!humanApproval) {
    throw new Error('[POLICY_VIOLATION] SA-01 requires an authenticated human approval');
  }
  validateHumanFinalDecision({
    accountability: approval.accountability,
    decidedByType: humanApproval.decidedByType,
    authenticated: humanApproval.authenticated,
    authMethod: humanApproval.authMethod,
    payloadHash: humanApproval.payloadHash,
    effectBinding: humanApproval.effectBinding,
  });
  return approval;
}

function rebuildMirror(
  mirrorDir: string,
  entries: AuditEntry[],
  rootDir = pathResolver.rootDir()
): void {
  const safeMirrorDir = assertSafeRepositoryPath(mirrorDir, {
    allowMissingLeaf: true,
    rootDir,
  });
  const byDate = new Map<string, AuditEntry[]>();
  for (const entry of entries) {
    const date = entry.timestamp.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`[AUDIT_MIRROR_INVALID] invalid master timestamp for ${entry.id}`);
    }
    const dateEntries = byDate.get(date) || [];
    dateEntries.push(entry);
    byDate.set(date, dateEntries);
  }
  safeMkdir(safeMirrorDir, { recursive: true });
  for (const [date, dateEntries] of [...byDate.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    safeWriteFile(
      assertSafeRepositoryPath(path.join(safeMirrorDir, `audit-${date}.jsonl`), {
        allowMissingLeaf: true,
        rootDir,
      }),
      `${dateEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      { encoding: 'utf8', mkdir: true }
    );
  }
}

export function runAuditMirrorReconciliation(input: {
  missionId: string;
  apply?: boolean;
  approvalRequestId?: string;
  rootDir?: string;
}): AuditMirrorReceipt {
  const rootDir = input.rootDir || pathResolver.rootDir();
  const findings = collectAuditMirrorFindings(rootDir);
  const approval = input.apply
    ? input.approvalRequestId
      ? assertAuditMirrorApproval(input.approvalRequestId, input.missionId, findings)
      : (() => {
          throw new Error('--approval-request-id is required with --apply');
        })()
    : undefined;
  const receipt: AuditMirrorReceipt = {
    mission_id: input.missionId,
    mode: input.apply ? 'apply' : 'dry-run',
    ...(approval?.decidedBy ? { approved_by: approval.decidedBy } : {}),
    ...(approval ? { approval_request_id: approval.id } : {}),
    generated_at: nowIso(),
    findings,
    archived: [],
    rebuilt: [],
  };

  if (input.apply) {
    const masterByTenant = masterEntriesByTenant(rootDir);
    const archiveRoot = assertSafeRepositoryPath(
      path.join(rootDir, 'active/archive/.trash', `audit-mirror-${Date.now().toString(36)}`),
      { allowMissingLeaf: true, rootDir }
    );
    withExecutionContext(
      'mission_controller',
      () => {
        safeMkdir(archiveRoot, { recursive: true });
        for (const finding of findings) {
          const source = assertSafeRepositoryPath(path.join(rootDir, finding.path), {
            allowMissingLeaf: true,
            rootDir,
          });
          if (!safeExistsSync(source)) continue;
          const destination = assertSafeRepositoryPath(path.join(archiveRoot, finding.path), {
            allowMissingLeaf: true,
            rootDir,
          });
          safeMkdir(path.dirname(destination), { recursive: true });
          safeMoveSync(source, destination);
          receipt.archived.push({
            from: finding.path,
            to: path.relative(rootDir, destination).replaceAll(path.sep, '/'),
          });

          if (finding.action === 'quarantine_and_rebuild') {
            const mirrorDir = assertSafeRepositoryPath(path.join(rootDir, finding.path), {
              allowMissingLeaf: true,
              rootDir,
            });
            const entries = masterByTenant.get(finding.slug) || [];
            rebuildMirror(mirrorDir, entries, rootDir);
            receipt.rebuilt.push({
              slug: finding.slug,
              path: finding.path,
              entries: entries.length,
            });
          }
        }
        const evidenceDir =
          (path.resolve(rootDir) === path.resolve(pathResolver.rootDir())
            ? missionEvidenceDir(input.missionId)
            : undefined) ||
          path.join(rootDir, 'active/missions/confidential', input.missionId, 'evidence');
        const safeEvidenceDir = assertSafeRepositoryPath(evidenceDir, {
          allowMissingLeaf: true,
          rootDir,
        });
        safeMkdir(safeEvidenceDir, { recursive: true });
        const receiptPath = assertSafeRepositoryPath(
          path.join(safeEvidenceDir, 'audit-mirror-reconciliation-receipt.json'),
          { allowMissingLeaf: true, rootDir }
        );
        receipt.receipt_path = path.relative(rootDir, receiptPath).replaceAll(path.sep, '/');
        safeWriteFile(receiptPath, JSON.stringify(receipt, null, 2));
      },
      'sovereign'
    );
  } else {
    const receiptPath = assertSafeRepositoryPath(
      path.join(
        rootDir,
        'active/missions/confidential',
        input.missionId,
        'evidence/audit-mirror-reconciliation-dry-run.json'
      ),
      { allowMissingLeaf: true, rootDir }
    );
    safeMkdir(path.dirname(receiptPath), { recursive: true });
    receipt.receipt_path = path.relative(rootDir, receiptPath).replaceAll(path.sep, '/');
    safeWriteFile(receiptPath, JSON.stringify(receipt, null, 2));
  }
  return receipt;
}

export function main(argv: string[] = []) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { result: { status: 'help', usage: AUDIT_MIRROR_USAGE }, failed: false };
  }
  const missionIndex = argv.indexOf('--mission-id');
  const missionId = missionIndex >= 0 ? argv[missionIndex + 1] : DEFAULT_AUDIT_MIRROR_MISSION;
  const apply = argv.includes('--apply');
  const requestApproval = argv.includes('--request-approval');
  const approvalIndex = argv.indexOf('--approval-request-id');
  const approvalRequestId = approvalIndex >= 0 ? argv[approvalIndex + 1] : undefined;
  const requestedByIndex = argv.indexOf('--requested-by');
  const requestedBy = requestedByIndex >= 0 ? argv[requestedByIndex + 1] : undefined;
  if (requestApproval) {
    const result = openAuditMirrorApproval({ missionId, ...(requestedBy ? { requestedBy } : {}) });
    return { result, failed: Boolean(result.reason) };
  }
  return {
    result: runAuditMirrorReconciliation({ missionId, apply, approvalRequestId }),
    failed: false,
  };
}

export const runAuditMirrorReconcile = defineScript({
  name: 'audit:mirror-reconcile',
  flags: [],
  run: (context) => {
    const outcome = main(context.argv);
    context.print(outcome.result);
    if (outcome.failed) throw new ScriptExitError(1, '', true);
    return outcome.result;
  },
});

if (
  isDirectScript(import.meta.url, 'audit_mirror_reconcile.ts') ||
  isDirectScript(import.meta.url, 'audit_mirror_reconcile.js')
)
  void runAuditMirrorReconcile();
