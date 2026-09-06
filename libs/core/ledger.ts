import { appendJsonLine, parseSafeJsonInput, readJsonLines } from './foundation/json.js';
import { readTextFile } from './foundation/text.js';
import { assertSafeRepositoryPath, safeMkdir, safeExistsSync, safeLstat } from './secure-io.js';
import * as pathResolver from './path-resolver.js';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  computeLedgerEntryHash,
  GENESIS_HASH,
  getAuditChainKeyId,
  resolveAuditChainKey,
  verifyLedgerEntryHash,
  type ChainAlg,
} from './chain-integrity.js';
import { withLockSync } from './src/lock-utils.js';
import {
  eventScopeMatches,
  normalizeEventScope,
  type EventScope,
  type EventScopeFilter,
} from './event-scope.js';
import { resolveScopeForRecord } from './scope-migration.js';
import { isRecord } from './foundation/text.js';
import { nowIso } from './foundation/time.js';

/**
 * Ecosystem Hybrid Ledger v2.0 [STANDARDIZED]
 * Provides a two-layered audit trail:
 * 1. Global System Ledger: Metadata only for system-wide events.
 * 2. Mission Ledger: Detailed execution logs within mission boundaries.
 */

export const GLOBAL_LEDGER_PATH = pathResolver.resolve('active/audit/system-ledger.jsonl');

type LedgerRecord = Record<string, unknown>;

const LEDGER_STRING_FIELDS = [
  'id',
  'timestamp',
  'type',
  'role',
  'mission_id',
  'detail_hash',
  'note',
  'parent_hash',
  'chain_alg',
  'chain_key_id',
  'hash',
] as const;

/**
 * Normalize a persisted ledger line before it reaches projections or hash
 * verification. Optional fields preserve old ledger formats, while known
 * envelope fields never silently change type.
 */
export function normalizeLedgerRecord(value: unknown): LedgerRecord | undefined {
  if (!isRecord(value)) return undefined;
  for (const field of LEDGER_STRING_FIELDS) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return undefined;
  }
  if (
    value.chain_alg !== undefined &&
    value.chain_alg !== 'sha256' &&
    value.chain_alg !== 'hmac-sha256'
  ) {
    return undefined;
  }
  for (const field of ['scope', 'scope_context', 'payload'] as const) {
    if (
      value[field] !== undefined &&
      value[field] !== null &&
      (typeof value[field] !== 'object' || Array.isArray(value[field]))
    ) {
      return undefined;
    }
  }
  return value;
}

function safeLedgerPath(ledgerPath: string): string {
  return assertSafeRepositoryPath(ledgerPath, { allowMissingLeaf: true });
}

function ensureRegularLedgerFile(ledgerPath: string): void {
  if (safeExistsSync(ledgerPath) && !safeLstat(ledgerPath).isFile()) {
    throw new Error(`[LEDGER_RESOURCE] ledger must be a regular file: ${ledgerPath}`);
  }
}

export const record = (type: string, data: any) => {
  const timestamp = nowIso();
  const missionId = data.mission_id;
  const scope = resolveLedgerScope(data);

  // 1. Determine Target Path
  let targetPath = GLOBAL_LEDGER_PATH;
  let isMissionSpecific = false;

  if (missionId && missionId !== 'None') {
    const missionPath = (pathResolver as any).findMissionPath(missionId);
    if (missionPath) {
      targetPath = safeLedgerPath(path.join(missionPath, 'evidence/ledger.jsonl'));
      isMissionSpecific = true;
    }
  }

  // 2. Record Detailed Entry (Target Ledger)
  const detailHash = _writeToLedger(targetPath, {
    timestamp,
    type,
    scope,
    role: data.role || 'Unknown',
    mission_id: missionId || 'None',
    payload: data,
  });

  // 3. Record Metadata Entry (Global Ledger) if mission-specific
  if (isMissionSpecific) {
    _writeToLedger(GLOBAL_LEDGER_PATH, {
      timestamp,
      type: `MISSION_EVENT:${type}`,
      scope,
      role: data.role || 'Unknown',
      mission_id: missionId,
      detail_hash: detailHash, // Link to the detailed ledger
      note: 'Metadata only. See mission evidence for details.',
    });
  }

  return detailHash;
};

/**
 * Internal helper to write an entry with hash chaining to a specific file.
 */
function _writeToLedger(ledgerPath: string, entryData: any): string {
  ledgerPath = safeLedgerPath(ledgerPath);
  const lockId = `ledger-${createHash('sha256').update(ledgerPath).digest('hex')}`;
  return withLockSync(lockId, () => {
    const lastHash = _getLastHash(ledgerPath);
    const chainKey = resolveAuditChainKey({ createIfMissing: true });
    if (!chainKey) throw new Error('missing_audit_chain_key');
    const entry: any = {
      ...entryData,
      parent_hash: lastHash,
      chain_alg: 'hmac-sha256' satisfies ChainAlg,
      chain_key_id: getAuditChainKeyId(chainKey),
    };

    const hash = computeLedgerEntryHash(entry, { alg: 'hmac-sha256', key: chainKey });
    entry.hash = hash;

    const dir = path.dirname(ledgerPath);
    if (!safeExistsSync(dir)) {
      safeMkdir(dir, { recursive: true });
    }

    appendJsonLine(ledgerPath, entry);
    return hash;
  });
}

function _getLastHash(ledgerPath: string) {
  ledgerPath = safeLedgerPath(ledgerPath);
  if (!safeExistsSync(ledgerPath)) return GENESIS_HASH;
  ensureRegularLedgerFile(ledgerPath);
  try {
    const content = readTextFile(ledgerPath);
    const trimmed = content.trim();
    if (!trimmed) return GENESIS_HASH;
    const lines = trimmed.split('\n');
    const lastEntry = normalizeLedgerRecord(
      parseSafeJsonInput(lines[lines.length - 1], 'ledger tail entry')
    );
    return lastEntry?.hash || GENESIS_HASH;
  } catch (_e) {
    return GENESIS_HASH;
  }
}

export interface LedgerIntegrityReport {
  ok: boolean;
  total: number;
  corrupted: string[];
  missingKey: boolean;
}

/**
 * Verify the integrity of a specific ledger file
 */
export const verifyIntegrity = (ledgerPath: string = GLOBAL_LEDGER_PATH): boolean => {
  return verifyLedgerIntegrityDetailed(ledgerPath).ok;
};

export const verifyLedgerIntegrityDetailed = (
  ledgerPath: string = GLOBAL_LEDGER_PATH
): LedgerIntegrityReport => {
  const safePath = safeLedgerPath(ledgerPath);
  if (!safeExistsSync(safePath)) {
    return { ok: true, total: 0, corrupted: [], missingKey: false };
  }
  ensureRegularLedgerFile(safePath);

  const content = readTextFile(safePath);
  const lines = content.trim().split('\n');
  let expectedParentHash = GENESIS_HASH;
  const corrupted: string[] = [];
  let total = 0;
  let missingKey = false;

  for (const [index, line] of lines.entries()) {
    if (!line) continue;
    total++;
    try {
      const entry = normalizeLedgerRecord(parseSafeJsonInput(line, 'ledger entry'));
      if (!entry) {
        corrupted.push(`line:${index + 1}:invalid_record`);
        continue;
      }
      const chainAlg = (entry.chain_alg ?? 'sha256') as ChainAlg;
      const chainKey =
        chainAlg === 'hmac-sha256' ? resolveAuditChainKey({ createIfMissing: false }) : null;
      const check = verifyLedgerEntryHash(entry, expectedParentHash, {
        alg: chainAlg,
        ...(chainKey ? { key: chainKey } : {}),
      });
      if (!check.ok) {
        if (check.reason === 'missing_audit_chain_key') missingKey = true;
        corrupted.push(
          entry.id ? String(entry.id) : `line:${index + 1}:${check.reason ?? 'invalid'}`
        );
      }
      expectedParentHash = String(entry.hash ?? '');
    } catch (_e) {
      corrupted.push(`line:${index + 1}:parse_error`);
    }
  }
  return {
    ok: corrupted.length === 0,
    total,
    corrupted,
    missingKey,
  };
};

/** Read the global ledger through the same explicit scope contract as events. */
export const loadForScope = (
  filter: EventScopeFilter,
  ledgerPath: string = GLOBAL_LEDGER_PATH
): Record<string, unknown>[] => {
  const safePath = safeLedgerPath(ledgerPath);
  if (!safeExistsSync(safePath)) return [];
  ensureRegularLedgerFile(safePath);
  return readJsonLines<unknown>(safePath, { onMalformed: 'skip' }).flatMap((value) => {
    try {
      const entry = normalizeLedgerRecord(value);
      if (!entry) return [];
      const scopeResult = resolveScopeForRecord(entry);
      if (scopeResult.disposition === 'invalid') return [];
      const scope = scopeResult.scope;
      return eventScopeMatches(scope, filter) ? [entry] : [];
    } catch {
      return [];
    }
  });
};

function resolveLedgerScope(data: Record<string, unknown>): EventScope {
  const source =
    data.scope && typeof data.scope === 'object' && !Array.isArray(data.scope)
      ? (data.scope as Record<string, unknown>)
      : data;
  const candidate = {
    ...source,
    ...(typeof data.tenant_slug === 'string' ? { tenant_slug: data.tenant_slug } : {}),
    ...(typeof data.organization_id === 'string' ? { organization_id: data.organization_id } : {}),
    ...(typeof data.project_id === 'string' ? { project_id: data.project_id } : {}),
    ...(typeof data.mission_id === 'string' ? { mission_id: data.mission_id } : {}),
    ...(typeof data.task_id === 'string' ? { task_id: data.task_id } : {}),
    tier: (source.tier as EventScope['tier'] | undefined) || 'public',
  };
  try {
    return normalizeEventScope(candidate);
  } catch {
    // The system ledger is also used by legacy callers that only know a
    // project or ticket id. Do not fail the business event; downgrade its
    // scope to system rather than inventing a parent tenant/organization.
    if (typeof data.tenant_slug === 'string') {
      try {
        return normalizeEventScope({
          tier: candidate.tier,
          tenant_slug: data.tenant_slug,
        });
      } catch {
        /* fall through to an explicitly system-scoped record */
      }
    }
    return normalizeEventScope({ tier: 'public', scope_kind: 'system' });
  }
}

// Legacy support
export const ledger = { record, verifyIntegrity };
