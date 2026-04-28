import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  safeReadFile,
  safeReaddir,
  safeLstat,
} from '@agent/core';

/**
 * SSRF guard contract test (operator-surface-strategy.md §9.1).
 *
 * The MOS is read-only and observation-only. It must not perform any
 * outbound network fetch from Server Components or Server Actions.
 * Any future regression that introduces remote `fetch()`, `axios`,
 * `node-fetch`, etc. will trip these checks.
 *
 * When a legitimate use case for outbound fetch arises (e.g. cross-region
 * audit log proxy), this test must be updated to allowlist the specific
 * call site AND a corresponding SSRF allowlist must be added to filter
 * operator-controlled URL fragments. The allowlist update is itself
 * an architectural change that requires SECURITY_READY review.
 */

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'src');

const OUTBOUND_NETWORK_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'global fetch()', re: /\bfetch\s*\(/ },
  { name: 'node:http import', re: /from\s+['"]node:http['"]|require\(['"]node:http['"]\)/ },
  { name: 'node:https import', re: /from\s+['"]node:https['"]|require\(['"]node:https['"]\)/ },
  { name: 'axios import', re: /from\s+['"]axios['"]|require\(['"]axios['"]\)/ },
  { name: 'node-fetch import', re: /from\s+['"]node-fetch['"]|require\(['"]node-fetch['"]\)/ },
  { name: 'undici import', re: /from\s+['"]undici['"]|require\(['"]undici['"]\)/ },
];

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

describe('MOS SSRF / outbound-network guard', () => {
  it('does not import or call any outbound network primitive', () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; pattern: string; line: number; text: string }> = [];
    for (const file of files) {
      const text = safeReadFile(file, { encoding: 'utf8' }) as string;
      const lines = text.split('\n');
      lines.forEach((line, idx) => {
        // Skip comment-only lines so commentary about the rule itself
        // does not trigger the matcher.
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
        for (const pattern of OUTBOUND_NETWORK_PATTERNS) {
          if (pattern.re.test(line)) {
            offenders.push({
              file: path.relative(ROOT, file),
              pattern: pattern.name,
              line: idx + 1,
              text: line.trim().slice(0, 120),
            });
          }
        }
      });
    }

    expect(
      offenders,
      `Outbound network usage detected (would expose SSRF surface):\n${offenders
        .map((o) => `  ${o.file}:${o.line} [${o.pattern}] ${o.text}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('next.config.mjs does not enable image optimization remote patterns', () => {
    const cfg = safeReadFile(path.join(ROOT, 'next.config.mjs'), { encoding: 'utf8' }) as string;
    // Image optimization can fetch remote URLs server-side; the MOS does
    // not need it and enabling it expands the SSRF surface.
    expect(cfg).not.toMatch(/remotePatterns/);
    expect(cfg).not.toMatch(/images:\s*{[^}]*domains:/m);
  });

  it('the data layer reads only known project-root prefixes', () => {
    // Belt-and-braces: data.ts uses pathResolver from @agent/core, which
    // refuses paths outside the project root via tier-guard. Verify the
    // file does not bypass it with absolute / file:// / http(s):// prefixes
    // in string literals.
    const data = safeReadFile(path.join(SRC, 'lib/data.ts'), { encoding: 'utf8' }) as string;
    expect(data).not.toMatch(/['"]https?:\/\//);
    expect(data).not.toMatch(/['"]file:\/\//);
    // Absolute /etc /var /tmp paths shouldn't appear as string literals.
    expect(data).not.toMatch(/['"]\/etc\//);
    expect(data).not.toMatch(/['"]\/var\//);
  });
});
