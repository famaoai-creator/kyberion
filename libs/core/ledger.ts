import { 
  safeReadFile, 
  safeAppendFileSync, 
  safeMkdir, 
  safeExistsSync 
} from './secure-io.js';
import * as pathResolver from './path-resolver.js';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Ecosystem Hybrid Ledger v2.0 [STANDARDIZED]
 * Provides a two-layered audit trail:
 * 1. Global System Ledger: Metadata only for system-wide events.
 * 2. Mission Ledger: Detailed execution logs within mission boundaries.
 */

const GLOBAL_LEDGER_PATH = pathResolver.resolve('active/audit/system-ledger.jsonl');

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
      note: "Metadata only. See mission evidence for details."
    });
  }

  return detailHash;
};

/**
 * Internal helper to write an entry with hash chaining to a specific file.
 */
function _writeToLedger(ledgerPath: string, entryData: any): string {
  const lastHash = _getLastHash(ledgerPath);
  const entry: any = {
    ...entryData,
    parent_hash: lastHash,
  };

  const hash = createHash('sha256').update(JSON.stringify(entry)).digest('hex');
  entry.hash = hash;

  const dir = path.dirname(ledgerPath);
  if (!safeExistsSync(dir)) {
    safeMkdir(dir, { recursive: true });
  }
  
  safeAppendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
  return hash;
}

function _getLastHash(ledgerPath: string) {
  if (!safeExistsSync(ledgerPath)) return '0'.repeat(64);
  try {
    const content = safeReadFile(ledgerPath, { encoding: 'utf8' }) as string;
    const trimmed = content.trim();
    if (!trimmed) return '0'.repeat(64);
    const lines = trimmed.split('\n');
    const lastEntry = JSON.parse(lines[lines.length - 1]);
    return lastEntry.hash || '0'.repeat(64);
  } catch (_e) {
    return '0'.repeat(64);
  }
}

/**
 * Verify the integrity of a specific ledger file
 */
export const verifyIntegrity = (ledgerPath: string = GLOBAL_LEDGER_PATH): boolean => {
  if (!safeExistsSync(ledgerPath)) return true;
  
  const content = safeReadFile(ledgerPath, { encoding: 'utf8' }) as string;
  const lines = content.trim().split('\n');
  let expectedParentHash = '0'.repeat(64);

  for (const line of lines) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      const { hash, ...dataWithoutHash } = entry;

      if (entry.parent_hash !== expectedParentHash) return false;

      const actualHash = createHash('sha256')
        .update(JSON.stringify(dataWithoutHash))
        .digest('hex');
      if (hash !== actualHash) return false;

      expectedParentHash = hash;
    } catch (_e) {
      return false;
    }
  }
  return true;
};

// Legacy support
export const ledger = { record, verifyIntegrity };
