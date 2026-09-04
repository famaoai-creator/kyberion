import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { parseDecisionRequestBody } from './serve-brief.js';

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
