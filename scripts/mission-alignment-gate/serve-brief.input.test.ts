import { describe, expect, it, vi } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

vi.mock('@agent/core/surface/operator-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/surface/operator-identity')>()),
  resolveOperatorDisplayName: () => 'operator-from-identity',
}));

import { parseDecisionRequestBody, resolveBriefDecider } from './serve-brief.js';

describe('mission alignment decision request boundary', () => {
  it('accepts an object body and preserves decision fields as data', () => {
    expect(
      parseDecisionRequestBody(
        JSON.stringify({
          decision: 'approved',
          decidedBy: 'operator',
          requestId: 'approval-1',
          note: 'reviewed',
        })
      )
    ).toEqual({
      decision: 'approved',
      decidedBy: 'operator',
      requestId: 'approval-1',
      note: 'reviewed',
    });
  });

  it.each(['[]', 'null', '"approved"'])('rejects a non-object body: %s', (raw) => {
    expect(() => parseDecisionRequestBody(raw)).toThrow('decision request must be a JSON object');
  });

  it('rejects dangerous nested keys before approval handling', () => {
    expect(() =>
      parseDecisionRequestBody('{"decision":"approved","meta":{"__proto__":{}}}')
    ).toThrow('decision request contains a dangerous JSON key');
  });

  it('routes server lifecycle output through the harness printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/mission-alignment-gate/serve-brief.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
  });
});

describe('mission brief decider identity (separation of duties)', () => {
  it('resolves the decider server-side and keeps the page-typed name only as a note', () => {
    expect(resolveBriefDecider({ decision: 'approved', decidedBy: 'mallory' }, {})).toEqual({
      decidedBy: 'operator-from-identity',
      pageName: 'mallory',
    });
    expect(resolveBriefDecider({ decision: 'approved' }, {})).toEqual({
      decidedBy: 'operator-from-identity',
    });
  });

  it('never forwards the POST body decidedBy to the approval decision', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/mission-alignment-gate/serve-brief.ts'), {
        encoding: 'utf8',
      }) || ''
    );
    expect(source).toContain('const decider = resolveBriefDecider(body);');
    expect(source.match(/body\?\.decidedBy/g)).toHaveLength(1);
  });
});
