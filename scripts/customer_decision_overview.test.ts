import { describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

const mocks = vi.hoisted(() => ({ runOverview: vi.fn(() => ({ ok: true })) }));
vi.mock('./customer-decision/overview.js', () => ({ runOverview: mocks.runOverview }));

import { runCustomerDecisionOverview } from './customer_decision_overview.js';

describe('customer_decision_overview (read-only facade entry)', () => {
  it('runs the overview verb with the parsed options', () => {
    const result = runCustomerDecisionOverview(
      ['overview', '--tenant', 'acme', '--summary'],
      '2026-11-04T00:00:00.000Z'
    );
    expect(result).toEqual({ ok: true });
    const [opts, flags, now] = mocks.runOverview.mock.calls[0] as unknown as [
      Record<string, string>,
      Set<string>,
      string,
    ];
    expect(opts.tenant).toBe('acme');
    expect(flags.has('summary')).toBe(true);
    expect(now).toBe('2026-11-04T00:00:00.000Z');
  });

  it.each(['respond', 'draft', 'learning', 'confirm', 'send'])(
    'refuses the %s verb, which belongs to the writer CLI',
    (verb) => {
      expect(() => runCustomerDecisionOverview([verb, '--tenant', 'acme'])).toThrow(
        /only the read-only 'overview' verb/
      );
    }
  );

  it('reaches no writer module: the read path imports only overview, common and its helpers', () => {
    const relativeImports = (file: string): string[] =>
      [
        ...String(safeReadFile(pathResolver.rootResolve(file), { encoding: 'utf8' })).matchAll(
          /from '(\.{1,2}\/[^']+)'/gu
        ),
      ].map((match) => {
        const parts = [...file.split('/').slice(0, -1), ...match[1]!.split('/')];
        const out: string[] = [];
        for (const part of parts) {
          if (part === '.') continue;
          if (part === '..') out.pop();
          else out.push(part);
        }
        return out.join('/').replace(/\.js$/u, '.ts');
      });
    const seen = new Set<string>();
    const queue = ['scripts/customer_decision_overview.ts'];
    while (queue.length) {
      const file = queue.shift()!;
      if (seen.has(file) || !file.startsWith('scripts/')) continue;
      seen.add(file);
      queue.push(...relativeImports(file));
    }
    expect([...seen].sort()).toEqual([
      'scripts/customer-decision/common.ts',
      'scripts/customer-decision/overview.ts',
      'scripts/customer-decision/superseded-locks.ts',
      'scripts/customer_decision_overview.ts',
      'scripts/lib/harness.ts',
    ]);
    // The read path calls none of the writers common.ts also exports.
    const readPath = [
      'scripts/customer-decision/overview.ts',
      'scripts/customer-decision/superseded-locks.ts',
    ]
      .map((file) => String(safeReadFile(pathResolver.rootResolve(file), { encoding: 'utf8' })))
      .join('\n');
    expect(readPath).not.toMatch(
      /\b(appendDealNote|auditChain|appendDecisions|applyPromotions|noteDealSwitches|auditFailure|audit\(|withCaseLock|safeWriteFile|safeAppendFile)\b/u
    );
  });
});
