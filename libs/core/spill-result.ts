/** DH-14: best-effort secure spill for oversized text results. */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import {
  safeChmodSync,
  safeCreateExclusiveFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
} from './secure-io.js';
import { pathResolver } from './path-resolver.js';

const SPILL_DIR = pathResolver.sharedTmp('spills');
const LOCATOR_PATTERN = /^spill:([a-f0-9]{32})$/u;

export interface SpillResult {
  value: string;
  locator?: string;
  spilled: boolean;
}

export interface SpillTextOptions {
  thresholdChars?: number;
  spillDir?: string;
}

function ensurePrivateSpillDir(directory: string): void {
  safeMkdir(directory, { recursive: true, mode: 0o700 });
  safeChmodSync(directory, 0o700);
}

/** Spill only when requested by size; any spill failure preserves the value. */
export function spillTextBestEffort(text: string, options: SpillTextOptions = {}): SpillResult {
  const threshold = options.thresholdChars ?? 32_000;
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error('[SPILL_POLICY] thresholdChars must be non-negative');
  }
  if (text.length <= threshold) return { value: text, spilled: false };

  const directory = options.spillDir ?? SPILL_DIR;
  const id = crypto.randomBytes(16).toString('hex');
  const filePath = path.join(directory, `${id}.spill`);
  try {
    ensurePrivateSpillDir(directory);
    safeCreateExclusiveFileSync(filePath, text);
    safeChmodSync(filePath, 0o600);
    return { value: text, locator: `spill:${id}`, spilled: true };
  } catch {
    return { value: text, spilled: false };
  }
}

/** Resolve an opaque locator only through the governed spill directory. */
export function readSpilledText(locator: string, options: SpillTextOptions = {}): string {
  const match = LOCATOR_PATTERN.exec(locator.trim());
  if (!match) throw new Error('[SPILL_LOCATOR_INVALID] invalid opaque spill locator');
  const directory = options.spillDir ?? SPILL_DIR;
  const filePath = path.join(directory, `${match[1]}.spill`);
  if (!safeExistsSync(filePath)) throw new Error('[SPILL_LOCATOR_MISSING] spill result not found');
  return String(safeReadFile(filePath, { encoding: 'utf8', cache: false }));
}
