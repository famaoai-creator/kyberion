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
 * Ecosystem Ledger v1.1 [STANDARDIZED]
 * Provides a centralized, tamper-evident audit trail for all governance events.
 */

const LEDGER_PATH = pathResolver.resolve('active/audit/governance-ledger.jsonl');

export const record = (type: string, data: any) => {
  const timestamp = new Date().toISOString();
  const lastHash = _getLastHash();

  const entry: any = {
    timestamp,
    type,
    role: data.role || 'Unknown',
    mission_id: data.mission_id || 'None',
    payload: data,
    parent_hash: lastHash,
  };

  const hash = createHash('sha256').update(JSON.stringify(entry)).digest('hex');
  entry.hash = hash;

  const dir = path.dirname(LEDGER_PATH);
  if (!safeExistsSync(dir)) {
    safeMkdir(dir, { recursive: true });
  }
  
  safeAppendFileSync(LEDGER_PATH, JSON.stringify(entry) + '\n');
  return hash;
};

function _getLastHash() {
  if (!safeExistsSync(LEDGER_PATH)) return '0'.repeat(64);
  try {
    const content = safeReadFile(LEDGER_PATH, { encoding: 'utf8' }) as string;
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
 * Verify the integrity of the entire ledger
 */
export const verifyIntegrity = (): boolean => {
  if (!safeExistsSync(LEDGER_PATH)) return true;
  
  const content = safeReadFile(LEDGER_PATH, { encoding: 'utf8' }) as string;
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
