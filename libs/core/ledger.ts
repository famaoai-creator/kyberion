import { appendJsonLine } from './foundation/json.js';
import { safeReadFile, safeMkdir, safeExistsSync } from './secure-io.js';
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

/**
 * Ecosystem Hybrid Ledger v2.0 [STANDARDIZED]
 * Provides a two-layered audit trail:
 * 1. Global System Ledger: Metadata only for system-wide events.
 * 2. Mission Ledger: Detailed execution logs within mission boundaries.
 */

export const GLOBAL_LEDGER_PATH = pathResolver.resolve('active/audit/system-ledger.jsonl');

export const record = (type: string, data: any) => {
  const timestamp = new Date().toISOString();
  const missionId = data.mission_id;
  const scope = resolveLedgerScope(data);

  // 1. Determine Target Path
  let targetPath = GLOBAL_LEDGER_PATH;
  let isMissionSpecific = false;

  if (missionId && missionId !== 'None') {
    const missionPath = (pathResolver as any).findMissionPath(missionId);
    if (missionPath) {
      targetPath = path.join(missionPath, 'evidence/ledger.jsonl');
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
  if (!safeExistsSync(ledgerPath)) return GENESIS_HASH;
  try {
    const content = safeReadFile(ledgerPath, { encoding: 'utf8' }) as string;
    const trimmed = content.trim();
    if (!trimmed) return GENESIS_HASH;
    const lines = trimmed.split('\n');
    const lastEntry = JSON.parse(lines[lines.length - 1]);
    return lastEntry.hash || GENESIS_HASH;
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
  if (!safeExistsSync(ledgerPath)) {
    return { ok: true, total: 0, corrupted: [], missingKey: false };
  }

  const content = safeReadFile(ledgerPath, { encoding: 'utf8' }) as string;
  const lines = content.trim().split('\n');
  let expectedParentHash = GENESIS_HASH;
  const corrupted: string[] = [];
  let total = 0;
  let missingKey = false;

  for (const [index, line] of lines.entries()) {
    if (!line) continue;
    total++;
    try {
      const entry = JSON.parse(line);
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
  if (!safeExistsSync(ledgerPath)) return [];
  const content = String(safeReadFile(ledgerPath, { encoding: 'utf8' }) || '');
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
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
