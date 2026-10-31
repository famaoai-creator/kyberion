import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { createJudgmentLatencyFixture } from '../organization/judgment-latency-fixture.js';
import { createDotReportMarker } from './dot-result-records.js';
import {
  mintDotResultOutcomePermit,
  consumeDotResultOutcomePermit,
  mintDotReportMarkerPermit,
  consumeDotReportMarkerPermit,
  type DotResultOutcomeOrigin,
  type DotReportMarkerOrigin,
} from './dot-result-origin.js';
const outcome = (): DotResultOutcomeOrigin => {
  const fixture = createJudgmentLatencyFixture();
  return {
    rootDir: path.resolve('active/shared/tmp/result-origin-fixture'),
    charter: structuredClone(fixture.charter),
    scope: { ...fixture.scope, tier: 'confidential', tenant_slug: 'synthetic-latency' },
    phase: 'active_execution',
    leaseId: 'actual-lease',
    row: {
      dot_id: fixture.charter.dot_id,
      work_item_id: 'actual-item',
      action_ref: 'actual-action',
      attempt_id: 'actual-run',
      mode: 'pipeline',
      status: 'done',
      summary: 'Trusted module reports its port outcome',
      started_at: '2026-10-31T00:00:00.000Z',
      completed_at: '2026-10-31T00:00:01.000Z',
      report_to_dot_id: fixture.charter.dot_id,
    },
  };
};
const report = (): DotReportMarkerOrigin => {
  const input = outcome();
  return {
    rootDir: input.rootDir,
    charter: input.charter,
    scope: input.scope,
    marker: createDotReportMarker({
      row: input.row,
      scope: input.scope,
      reportTo: input.row.dot_id,
      enqueuedAt: '2026-10-31T00:00:02.000Z',
    }),
  };
};
describe('trusted module one-shot result permits (not store authenticity)', () => {
  it('accepts exactly one matching detached original and rejects replay', () => {
    const input = outcome(),
      token = mintDotResultOutcomePermit(input);
    expect(Object.isFrozen(token)).toBe(true);
    expect(() => consumeDotResultOutcomePermit(token, structuredClone(input))).not.toThrow();
    expect(() => consumeDotResultOutcomePermit(token, input)).toThrow();
  });
  it('model JSON, prototype clones, structured clones and copied token properties cannot forge the WeakMap origin', () => {
    const input = outcome(),
      token = mintDotResultOutcomePermit(input);
    for (const forged of [
      { kind: 'outcome', ...input },
      JSON.parse(JSON.stringify(token)),
      structuredClone(token),
      { ...token },
      Object.create(token),
    ])
      expect(() => consumeDotResultOutcomePermit(forged, input)).toThrow();
    expect(() => consumeDotResultOutcomePermit(token, input)).not.toThrow();
  });
  it.each(['root', 'scope', 'charter', 'row', 'phase', 'lease', 'actor', 'run'] as const)(
    'binds exact immutable %s and consumes even a mismatched attempt',
    (field) => {
      const original = outcome(),
        token = mintDotResultOutcomePermit(original),
        changed = structuredClone(original);
      if (field === 'root')
        changed.rootDir = path.resolve('active/shared/tmp/other-origin-fixture');
      if (field === 'scope') changed.scope.project_id = 'another-project';
      if (field === 'charter') changed.charter.version = 'different';
      if (field === 'row') changed.row.summary = 'changed status prose';
      if (field === 'phase') changed.phase = 'pipeline_continuation';
      if (field === 'lease') changed.leaseId = 'another-lease';
      if (field === 'actor') changed.row.dot_id = 'another-dot';
      if (field === 'run') changed.row.attempt_id = 'another-run';
      expect(() => consumeDotResultOutcomePermit(token, changed)).toThrow();
      expect(() => consumeDotResultOutcomePermit(token, original)).toThrow();
    }
  );
  it('mutating the issuer container cannot alter the captured origin', () => {
    const input = outcome(),
      pristine = structuredClone(input),
      token = mintDotResultOutcomePermit(input);
    input.row.status = 'blocked';
    input.charter.purpose = 'different';
    expect(() => consumeDotResultOutcomePermit(token, pristine)).not.toThrow();
  });
  it('rejects skipped, missing active lease, relative root, foreign scope and internal writer charters', () => {
    const skipped = outcome();
    skipped.row.status = 'skipped';
    const missing = outcome();
    delete missing.leaseId;
    const relative = outcome();
    relative.rootDir = 'relative';
    const foreign = outcome();
    foreign.scope.tenant_slug = 'another-tenant';
    const internal = outcome();
    internal.charter.authority.authority_role = 'dot_result_writer';
    for (const value of [skipped, missing, relative, foreign, internal])
      expect(() => mintDotResultOutcomePermit(value)).toThrow();
  });
  it('negative recovery never manufactures a successful outcome; other phases do not prove active claims', () => {
    const input = outcome();
    input.phase = 'negative_recovery';
    delete input.leaseId;
    expect(() => mintDotResultOutcomePermit(input)).toThrow();
    input.row.mode = 'escalated';
    input.row.status = 'blocked';
    const token = mintDotResultOutcomePermit(input);
    expect(() => consumeDotResultOutcomePermit(token, input)).not.toThrow();
    // P3b must still validate real recovery history; this token is origin structure only.
  });
  it('report markers have a distinct one-shot origin that cannot consume an outcome token', () => {
    const input = report(),
      token = mintDotReportMarkerPermit(input),
      other = mintDotResultOutcomePermit(outcome());
    expect(() => consumeDotReportMarkerPermit(other, input)).toThrow();
    expect(() => consumeDotReportMarkerPermit(token, structuredClone(input))).not.toThrow();
    expect(() => consumeDotReportMarkerPermit(token, input)).toThrow();
  });
  it('rejects changed report marker body, copied tokens and cross-DOT marker issuance', () => {
    const input = report(),
      token = mintDotReportMarkerPermit(input),
      changed = structuredClone(input);
    changed.marker.report_enqueued_at = '2026-10-31T00:00:03.000Z';
    expect(() => consumeDotReportMarkerPermit(token, changed)).toThrow();
    expect(() => consumeDotReportMarkerPermit(token, input)).toThrow();
    const forged = { ...mintDotReportMarkerPermit(input) };
    expect(() => consumeDotReportMarkerPermit(forged, input)).toThrow();
    input.marker.dot_id = 'foreign-dot';
    expect(() => mintDotReportMarkerPermit(input)).toThrow();
  });
});
