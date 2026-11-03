/* eslint-disable no-restricted-imports */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isFrontDeskMemberApiPath } from '../src/lib/front-desk-fetch';

/**
 * Member-API sweep (E2E-7): the frontDeskFetch allowlist must cover every
 * callsite, and every literal `/api/*` fetch in client code must have a
 * route handler — the TypeError class that silently broke the service
 * catalog / LLM selection panels until they were allowlisted.
 */

const srcDir = path.join(__dirname, '..', 'src');
const apiDir = path.join(srcDir, 'app', 'api');

function walk(dir: string, filter: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory() && !['node_modules', '.next'].includes(entry.name)) {
      walk(p, filter, out);
    } else if (entry.isFile() && filter(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

const clientFiles = walk(
  srcDir,
  (name) => /\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx')
).filter((file) => !file.split(path.sep).includes('api'));

const routePaths = new Set(
  walk(apiDir, (name) => name === 'route.ts' || name === 'route.tsx').map(
    (file) =>
      '/' + path.relative(path.join(srcDir, 'app'), path.dirname(file)).split(path.sep).join('/')
  )
);

/** Literal path prefixes written in fetch calls — `'/api/x/' + id` and
 *  `` `/api/x/${id}` `` both yield the root, so suffix-route probes use a
 *  sample segment. */
function collectCalls(): Map<string, string> {
  const calls = new Map<string, string>();
  const patterns = [
    /frontDeskFetch\s*\(\s*[`'"]([^`'"]*)[`'"]/g,
    /frontDeskFetch\s*\(\s*[`'"]([^`'"]*)[`'"]\s*\+\s*[A-Za-z_]/g,
    /(?<![\w.])fetch\s*\(\s*[`'"](\/api\/[^`'"$?#]*)/g,
  ];
  for (const file of clientFiles) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source))) {
        const literal = match[1].replace(/\$\{.*$/, '').replace(/[?#].*$/, '');
        if (literal.startsWith('/api/')) calls.set(literal, file);
      }
    }
  }
  return calls;
}

describe('member API sweep', () => {
  it('every literal frontDeskFetch callsite is an allowed member path', () => {
    const violations: string[] = [];
    const re = /frontDeskFetch\s*\(\s*[`'"]([^`'"]*)[`'"]/g;
    for (const file of clientFiles) {
      const source = fs.readFileSync(file, 'utf8');
      let match: RegExpExecArray | null;
      while ((match = re.exec(source))) {
        const literal = match[1].replace(/\$\{.*$/, '').replace(/[?#].*$/, '');
        if (!literal.startsWith('/api/')) continue;
        const probe = literal.endsWith('/') ? literal + 'sample-id' : literal;
        if (!isFrontDeskMemberApiPath(probe)) {
          violations.push(`${match[1]} (${path.relative(srcDir, file)})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('every literal /api fetch prefix maps to a route handler', () => {
    const calls = collectCalls();
    const missing: string[] = [];
    for (const [literal, file] of calls) {
      // A prefix ending in '/' targets a dynamic ([id]) child route; strip
      // it and check the parent has any descendant route.
      const probe = literal.replace(/\/+$/, '');
      const found =
        routePaths.has(probe) || [...routePaths].some((route) => route.startsWith(probe + '/'));
      if (!found) missing.push(`${literal} (${path.relative(srcDir, file)})`);
    }
    expect(missing).toEqual([]);
  });
});
