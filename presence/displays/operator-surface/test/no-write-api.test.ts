import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  pathResolver,
  safeReadFile,
  safeReaddir,
  safeLstat,
  safeExistsSync,
} from '@agent/core';

/**
 * Contract test (MOS acceptance criterion §9.1):
 *
 *   The MOS must not import any write APIs from @agent/core. Operators
 *   may only read filesystem state. This test scans every TS/TSX file
 *   under `src/` for forbidden imports and forbidden literal references
 *   to write surfaces.
 *
 *   Failure here is a security regression, not a style issue.
 */

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'src');

const FORBIDDEN_IDENTIFIERS = [
  'safeWriteFile',
  'safeAppendFileSync',
  'safeMkdir',
  'safeUnlinkSync',
  'safeRmdirSync',
  'safeRenameSync',
  'process.env.KYBERION_AUDIT_FORWARDER',
];

// `auditChain.record` is allowed in src/lib/audit-mos.ts (the single
// chokepoint that emits mos.read events per operator-surface-strategy.md
// §9.1) and forbidden everywhere else under src/.
const AUDIT_CHAIN_ALLOWED_RELATIVE = 'src/lib/audit-mos.ts';

const FORBIDDEN_HTTP_METHODS_RE = /\bexport\s+(async\s+)?(function|const)\s+(POST|PUT|PATCH|DELETE)\b/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of safeReaddir(dir)) {
    const abs = path.join(dir, entry);
    let stat;
    try {
      stat = safeLstat(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...walk(abs));
    } else if (stat.isFile() && /\.(ts|tsx)$/.test(entry)) {
      out.push(abs);
    }
  }
  return out;
}

describe('MOS no-write-API contract', () => {
  it('src tree exists', () => {
    expect(safeExistsSync(SRC)).toBe(true);
  });

  it('does not import any @agent/core write API', () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; identifier: string; line: number }> = [];
    for (const file of files) {
      const text = safeReadFile(file, { encoding: 'utf8' }) as string;
      const lines = text.split('\n');
      lines.forEach((line, idx) => {
        for (const id of FORBIDDEN_IDENTIFIERS) {
          if (line.includes(id)) {
            offenders.push({
              file: path.relative(ROOT, file),
              identifier: id,
              line: idx + 1,
            });
          }
        }
      });
    }

    expect(
      offenders,
      `Forbidden write-API references found:\n${offenders
        .map((o) => `  ${o.file}:${o.line} → ${o.identifier}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('only audit-mos.ts may reference auditChain.record', () => {
    const files = walk(SRC);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file);
      if (rel === AUDIT_CHAIN_ALLOWED_RELATIVE) continue;
      const text = safeReadFile(file, { encoding: 'utf8' }) as string;
      if (text.includes('auditChain.record')) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `auditChain.record may only appear in ${AUDIT_CHAIN_ALLOWED_RELATIVE}, but was also found in:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('exports no HTTP write methods (POST/PUT/PATCH/DELETE)', () => {
    const files = walk(SRC);
    const offenders: string[] = [];
    for (const file of files) {
      const text = safeReadFile(file, { encoding: 'utf8' }) as string;
      if (FORBIDDEN_HTTP_METHODS_RE.test(text)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the data layer never references safeWriteFile / safeMkdir', () => {
    const dataLayer = path.join(SRC, 'lib/data.ts');
    const text = safeReadFile(dataLayer, { encoding: 'utf8' }) as string;
    expect(text).not.toContain('safeWriteFile');
    expect(text).not.toContain('safeMkdir');
    expect(text).not.toContain('safeAppendFileSync');
  });
});
