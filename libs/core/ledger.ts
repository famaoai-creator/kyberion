import { safeReadFile, safeAppendFileSync, safeMkdir, safeExistsSync } from './secure-io.js';
import * as pathResolver from './path-resolver.js';
import * as path from 'node:path';
import {
  computeLedgerEntryHash,
  GENESIS_HASH,
  getAuditChainKeyId,
  resolveAuditChainKey,
  verifyLedgerEntryHash,
  type ChainAlg,
} from './chain-integrity.js';

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
    role: data.role || 'Unknown',
    mission_id: missionId || 'None',
    payload: data,
  });

  // 3. Record Metadata Entry (Global Ledger) if mission-specific
  if (isMissionSpecific) {
    _writeToLedger(GLOBAL_LEDGER_PATH, {
      timestamp,
      type: `MISSION_EVENT:${type}`,
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

  safeAppendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
  return hash;
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

// Legacy support
export const ledger = { record, verifyIntegrity };
