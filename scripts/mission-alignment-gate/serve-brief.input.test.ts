import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

const fixture = vi.hoisted(() => ({ owner: false, overlayPath: null as string | null }));
vi.mock('@agent/core/organization/member-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/organization/member-registry')>()),
  resolveMemberByPrincipal: () =>
    fixture.owner ? { member_id: 'owner', display_name: 'Alice', status: 'active' } : null,
}));
vi.mock('@agent/core/customer-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/customer-resolver')>();
  return {
    ...actual,
    customerRoot: (subPath = '', ...rest: unknown[]) =>
      subPath === 'policy/approval-policy.json' && fixture.overlayPath
        ? fixture.overlayPath
        : (actual.customerRoot as (...args: unknown[]) => string | null)(subPath, ...rest),
  };
});

vi.mock('@agent/core/surface/operator-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/surface/operator-identity')>()),
  resolveOperatorDisplayName: () => 'operator-from-identity',
}));

import { safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { parseDecisionRequestBody, resolveBriefDecider } from './serve-brief.js';

function separationOfDuties(enabled: boolean): void {
  const product = JSON.parse(
    String(
      safeReadFile(pathResolver.knowledge('product/governance/approval-policy.json'), {
        encoding: 'utf8',
      })
    )
  );
  const file = pathResolver.sharedTmp(`serve-brief-sod-${process.pid}.json`);
  safeWriteFile(file, JSON.stringify({ ...product, separation_of_duties: { enabled } }));
  fixture.overlayPath = file;
}

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

  describe('agent sessions', () => {
    afterEach(() => {
      fixture.owner = false;
      if (fixture.overlayPath) safeRmSync(fixture.overlayPath, { force: true });
      fixture.overlayPath = null;
    });

    it('with SoD off, records a decision made by a server in an agent session as caller_supplied', () => {
      fixture.owner = true;
      expect(resolveBriefDecider({ decision: 'approved' }, { CLAUDECODE: '1' })).toEqual({
        decidedBy: 'user:owner',
        deciderIdentitySource: 'caller_supplied',
        decidedInAgentSession: 'agent:claude-code',
      });
    });

    it('with SoD on, refuses to serve approvals from an agent session', () => {
      fixture.owner = true;
      separationOfDuties(true);
      expect(resolveBriefDecider({ decision: 'approved' }, { CLAUDECODE: '1' }).refusal).toMatch(
        /runs inside an agent session \(agent:claude-code\).*Chronos or presence-studio/
      );
      expect(resolveBriefDecider({ decision: 'approved' }, {}).refusal).toBeUndefined();
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
