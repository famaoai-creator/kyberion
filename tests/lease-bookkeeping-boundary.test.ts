import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

/**
 * Lease bookkeeping boundary — the done signal of W3 (Concept Model v2 D2:
 * one Lease primitive).
 *
 * Only `libs/core/lease/` decides who holds a lease, until when, and in which
 * generation. Every other lease implementation is an adapter: it may store
 * those values in its own record shape, but it never computes them. The gate
 * flags the three ways an adapter keeps its own bookkeeping:
 *
 *  - expiry: `expires_at` / `expires_at_ms` computed from a clock or written
 *    as the release marker (`new Date(Date.now() + ttl)`, `now + ttlMs`, `0`);
 *  - holder: a lease record's `holder_*` / `owner_id` set from anything but
 *    lease terms or the same field of another record;
 *  - fence: a generation advanced by hand (`fence: previous + 1`).
 *
 * Values that come from lease terms (`grantLeaseTerms`, `renewLeaseTerms`,
 * `releaseLeaseTerms`, `leaseExpiresAtIso(terms)`) pass. Inputs to the
 * primitive (`grantLeaseTerms({ holder: actor })`) are not record writes and
 * are not matched (`holder:` without a suffix). `holder_user_id` is the human
 * principal behind a peer holder — descriptive, not decided by the lease.
 *
 * Scope: non-test TypeScript outside `libs/core/lease/` that names a lease
 * type (an identifier containing `Lease`). Comments are ignored. Leases
 * outside the D2 inventory are listed in `OUT_OF_SCOPE_FILES` with a reason.
 */

const rootDir = process.cwd();
const codeFileRe = /\.(ts|tsx|mts|cts)$/;
const testFileRe = /(\.test\.|\.spec\.|__tests__|\.live\.test\.)/;
const leaseTypeRe = /\b[A-Z][A-Za-z]*Lease[A-Za-z]*\b/;
const LEASE_FIELDS = ['expires_at', 'holder_', 'owner_id', 'fence'];
const fromTerms = (rhs: string): boolean => /\bterms\b|Terms\b/.test(rhs);

interface Rule {
  name: 'expiry' | 'holder' | 'fence';
  pattern: RegExp;
  allowed: (rhs: string) => boolean;
}

const RULES: Rule[] = [
  {
    name: 'expiry',
    pattern: /(?:^|[{,(\s.])(expires_at(?:_ms)?)\s*(?::|=(?!=))\s*(.+)$/,
    allowed: (rhs) => fromTerms(rhs) || !(/Date\.now|new Date\(|\+/.test(rhs) || /^0\b/.test(rhs)),
  },
  {
    name: 'holder',
    pattern: /(?:^|[{,(\s.])(holder_(?!user_id)[a-z_]+|owner_id)\s*(?::|=(?!=))\s*(.+)$/,
    allowed: (rhs) =>
      fromTerms(rhs) ||
      // copy of the same field from another record
      /[\w\])?!]\.(?:holder(?:_[a-z_]+)?|owner_id)\b/.test(rhs) ||
      // type annotation (`holder_provider: CoSessionProvider;`)
      /^(?:string|number|[A-Z][\w<>[\]]*)(?:\s*\|\s*[\w'"]+)*\s*[;,]?\s*$/.test(rhs) ||
      /^undefined\b/.test(rhs),
  },
  {
    name: 'fence',
    pattern: /(?:^|[{,(\s.])(fence)\s*(?::|=(?!=))\s*(.+)$/,
    allowed: (rhs) => fromTerms(rhs) || !/\+\s*1\b|\+\+/.test(rhs),
  },
];

/**
 * Leases that are not part of the D2 inventory (work_item, mission, path,
 * device, dot_slot). Each needs a reason; move a file out of this list when
 * it becomes an adapter.
 */
const OUT_OF_SCOPE_FILES: Record<string, string> = {
  'libs/core/browser/browser-extension-bridge.ts':
    'browser extension session lease (pairing token lifetime), not a D2 resource lease',
};

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function isScanned(relPath: string): boolean {
  if (!codeFileRe.test(relPath) || testFileRe.test(relPath)) return false;
  if (relPath.endsWith('.d.ts')) return false;
  if (
    relPath.includes('/node_modules/') ||
    relPath.startsWith('node_modules/') ||
    relPath.includes('/dist/') ||
    relPath.includes('/.next/') ||
    relPath.includes('/.worktrees/') ||
    relPath.startsWith('.worktrees/') ||
    relPath.includes('/retired/') ||
    relPath.startsWith('tests/') ||
    relPath.startsWith('active/') ||
    relPath.startsWith('knowledge/')
  )
    return false;
  return !relPath.startsWith('libs/core/lease/');
}

/** Strip `//` line comments and block comments (good enough for a line gate). */
function codeLines(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let inBlock = false;
  source.split('\n').forEach((raw, index) => {
    let text = raw;
    if (inBlock) {
      const end = text.indexOf('*/');
      if (end === -1) return;
      text = text.slice(end + 2);
      inBlock = false;
    }
    text = text.replace(/\/\*.*?\*\//g, '');
    const start = text.indexOf('/*');
    if (start !== -1) {
      text = text.slice(0, start);
      inBlock = true;
    }
    text = text.replace(/(^|[^:'"`])\/\/.*$/, '$1');
    if (text.trim()) out.push({ line: index + 1, text });
  });
  return out;
}

interface Violation {
  file: string;
  line: number;
  rule: Rule['name'];
  text: string;
}

export function scanLeaseBookkeeping(source: string, file = '<source>'): Violation[] {
  const violations: Violation[] = [];
  if (!leaseTypeRe.test(source)) return violations;
  if (!LEASE_FIELDS.some((field) => source.includes(field))) return violations;
  for (const { line, text } of codeLines(source)) {
    for (const rule of RULES) {
      const match = rule.pattern.exec(text);
      if (!match) continue;
      if (rule.allowed(match[2]!.trim())) continue;
      violations.push({ file, line, rule: rule.name, text: text.trim() });
    }
  }
  return violations;
}

function scanRepository(): Violation[] {
  const violations: Violation[] = [];
  for (const absolute of getAllFiles(rootDir)) {
    const rel = normalize(path.relative(rootDir, absolute));
    if (!isScanned(rel) || OUT_OF_SCOPE_FILES[rel]) continue;
    const source = safeReadFile(absolute, { encoding: 'utf8' }) as string;
    violations.push(...scanLeaseBookkeeping(source, rel));
  }
  return violations;
}

describe('Lease bookkeeping boundary (W3)', () => {
  it('lets only libs/core/lease/ decide lease holder, expiry and fence', () => {
    const violations = scanRepository();
    expect(
      violations,
      violations.length
        ? [
            'Lease-owned fields computed outside libs/core/lease/ — take them from lease terms',
            '(grantLeaseTerms / renewLeaseTerms / releaseLeaseTerms / leaseExpiresAtIso):',
            ...violations.map((v) => `  [${v.rule}] ${v.file}:${v.line}  ${v.text}`),
          ].join('\n')
        : ''
    ).toEqual([]);
  });

  it('flags the pre-W3 adapter shapes (the gate is not vacuous)', () => {
    const preW3 = [
      'interface WorkLease {',
      '  holder_peer_id: string;',
      '  expires_at: string;',
      '}',
      'const lease: WorkLease = {',
      '  holder_peer_id: input.actorPeerId,',
      '  expires_at: new Date(Date.now() + (input.ttlMs || 15 * 60 * 1000)).toISOString(),',
      '  fence: previous.fence + 1,',
      '};',
      'record.expires_at = new Date(nowMs + ttlMs).toISOString();',
    ].join('\n');
    expect(scanLeaseBookkeeping(preW3).map((v) => `${v.rule}:${v.line}`)).toEqual([
      'holder:6',
      'expiry:7',
      'fence:8',
      'expiry:10',
    ]);
    const adapter = [
      'interface WorkLease {',
      '  holder_peer_id: string;',
      '  expires_at: string;',
      '}',
      'const lease: WorkLease = {',
      '  holder_peer_id: terms.holder,',
      '  expires_at: leaseExpiresAtIso(terms),',
      '  fence: terms.fence,',
      '  ...(error ? { holder_peer_id: current.holder_peer_id } : {}),',
      '};',
    ].join('\n');
    expect(scanLeaseBookkeeping(adapter)).toEqual([]);
  });

  it('keeps every out-of-scope entry justified and present', () => {
    for (const [file, reason] of Object.entries(OUT_OF_SCOPE_FILES)) {
      expect(reason.trim().length, file).toBeGreaterThan(10);
      expect(
        () => safeReadFile(path.join(rootDir, file), { encoding: 'utf8' }),
        file
      ).not.toThrow();
    }
  });
});
