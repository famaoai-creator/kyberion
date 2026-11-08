import { describe, expect, it } from 'vitest';
import type { ScheduledPipeline } from '@agent/core/pipeline/pipeline-scheduler';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertRunnablePipelinePath,
  parseScheduleMutation,
  parseScheduleTrigger,
  scheduleAdmitsTenantScope,
  scheduleTenantSlug,
} from '../src/lib/ops/pipeline-schedules';

/**
 * Validation-only tests for the schedule mutation parser. They exercise the
 * pure input checks (id pattern, trigger shape, path containment/existence)
 * and never touch the schedule registry — `parseScheduleMutation` builds an
 * in-memory `ScheduledPipeline`; nothing here calls `register*`. The one file
 * that must exist (`pipelines/daily-routine.json`) is read, not written.
 */

const RUNNABLE = 'pipelines/daily-routine.json';

const baseRegister = {
  id: 'nightly.report',
  name: 'Nightly report',
  pipelinePath: RUNNABLE,
  actuator: 'system',
  trigger: { type: 'interval', intervalMs: 3_600_000 },
  enabled: true,
};

const existing: ScheduledPipeline = {
  id: 'nightly.report',
  name: 'Nightly report',
  // A path that does not exist on disk — proves updates keep fields without
  // re-running the existence check (a deleted target must not block edits).
  pipelinePath: 'pipelines/__removed__.json',
  actuator: 'system',
  trigger: { type: 'interval', intervalMs: 3_600_000 },
  enabled: true,
};

describe('parseScheduleTrigger', () => {
  it('accepts a five-field cron expression', () => {
    expect(parseScheduleTrigger({ type: 'cron', cron: '0 9 * * 1-5' })).toEqual({
      type: 'cron',
      cron: '0 9 * * 1-5',
    });
  });

  it('accepts a cron with a valid IANA timezone', () => {
    expect(
      parseScheduleTrigger({ type: 'cron', cron: '30 8 * * *', timezone: 'Asia/Tokyo' })
    ).toEqual({ type: 'cron', cron: '30 8 * * *', timezone: 'Asia/Tokyo' });
  });

  it('rejects cron expressions that are not exactly five fields', () => {
    for (const cron of ['0 9 * *', '0 9 * * * *', '', '* * * * * *']) {
      expect(() => parseScheduleTrigger({ type: 'cron', cron })).toThrow(/cron/);
    }
  });

  it('rejects intervals below one minute and non-finite values', () => {
    for (const intervalMs of [59_999, 0, -1, Number.NaN]) {
      expect(() => parseScheduleTrigger({ type: 'interval', intervalMs })).toThrow(/intervalMs/);
    }
    expect(parseScheduleTrigger({ type: 'interval', intervalMs: 60_000 })).toEqual({
      type: 'interval',
      intervalMs: 60_000,
    });
    // The parser coerces: a numeric string is a valid interval.
    expect(parseScheduleTrigger({ type: 'interval', intervalMs: '60000' })).toEqual({
      type: 'interval',
      intervalMs: 60_000,
    });
  });

  it('rejects unknown trigger types and non-object triggers', () => {
    for (const trigger of [undefined, null, '0 9 * * *', [], { type: 'hourly' }, { type: '' }]) {
      expect(() => parseScheduleTrigger(trigger)).toThrow();
    }
  });

  it('rejects a timezone that is not a valid IANA zone', () => {
    expect(() =>
      parseScheduleTrigger({ type: 'cron', cron: '0 9 * * *', timezone: 'Mars/Olympus' })
    ).toThrow(/IANA/);
  });
});

describe('assertRunnablePipelinePath', () => {
  it('accepts a repo-relative path to an existing pipeline file', () => {
    expect(assertRunnablePipelinePath(RUNNABLE)).toBe(RUNNABLE);
  });

  it('normalizes an absolute path inside the repository to its relative form', () => {
    expect(assertRunnablePipelinePath(pathResolver.rootResolve(RUNNABLE))).toBe(RUNNABLE);
  });

  it('rejects paths outside pipelines/', () => {
    expect(() => assertRunnablePipelinePath('scripts/mission_controller.ts')).toThrow(
      /pipelines\//
    );
  });

  it('rejects shared fragments (never runnable directly)', () => {
    expect(() => assertRunnablePipelinePath('pipelines/fragments/step.json')).toThrow(/fragment/);
  });

  it('rejects a pipeline path that does not exist on disk', () => {
    expect(() => assertRunnablePipelinePath('pipelines/__missing__.json')).toThrow(/not found/);
  });

  it('rejects .. segments even when they stay inside the repo', () => {
    // `pipelines/../package.json` resolves inside the root and exists, but it
    // is not a pipeline — the prefix check must run on the raw segments.
    expect(() => assertRunnablePipelinePath('pipelines/../package.json')).toThrow(/\.\./);
    expect(() => assertRunnablePipelinePath('pipelines/sub/../../x.json')).toThrow(/\.\./);
  });

  it('rejects non-.json files and out-of-repo paths', () => {
    expect(() => assertRunnablePipelinePath('pipelines/notes.txt')).toThrow(/\.json/);
    expect(() => assertRunnablePipelinePath('/etc/hosts')).toThrow(/repo-relative|pipelines\//);
  });
});

describe('parseScheduleMutation — register', () => {
  it('builds a scheduled pipeline from a complete input', () => {
    const schedule = parseScheduleMutation(baseRegister);
    expect(schedule).toMatchObject({
      id: 'nightly.report',
      name: 'Nightly report',
      pipelinePath: RUNNABLE,
      actuator: 'system',
      enabled: true,
      trigger: { type: 'interval', intervalMs: 3_600_000 },
    });
  });

  it('rejects ids outside the allowed pattern', () => {
    for (const id of ['', 'has space', 'a/b', '..', '.hidden', 'a:b:c ok']) {
      expect(() => parseScheduleMutation({ ...baseRegister, id })).toThrow(/id/);
    }
  });

  it('requires a name on register', () => {
    expect(() => parseScheduleMutation({ ...baseRegister, name: undefined })).toThrow(/name/);
  });

  it('requires the pipeline path to live under pipelines/ and to exist', () => {
    expect(() => parseScheduleMutation({ ...baseRegister, pipelinePath: 'scripts/x.ts' })).toThrow(
      /pipelines\//
    );
    expect(() =>
      parseScheduleMutation({ ...baseRegister, pipelinePath: 'pipelines/__missing__.json' })
    ).toThrow(/not found/);
  });

  it('requires a trigger on register', () => {
    expect(() => parseScheduleMutation({ ...baseRegister, trigger: undefined })).toThrow(/trigger/);
  });

  it('rejects a non-object context', () => {
    expect(() =>
      parseScheduleMutation({ ...baseRegister, context: ['not', 'an', 'object'] })
    ).toThrow(/context/);
  });

  it('rejects a non-boolean enabled instead of coercing it', () => {
    for (const enabled of ['false', 'true', 0, 1, '']) {
      expect(() => parseScheduleMutation({ ...baseRegister, enabled })).toThrow(/enabled/);
    }
    expect(parseScheduleMutation({ ...baseRegister, enabled: false }).enabled).toBe(false);
  });
});

describe('parseScheduleMutation — update', () => {
  it('keeps every omitted field, including a pipeline file that no longer exists', () => {
    const updated = parseScheduleMutation({ enabled: false }, existing);
    expect(updated).toMatchObject({
      id: existing.id,
      name: existing.name,
      pipelinePath: existing.pipelinePath,
      actuator: existing.actuator,
      trigger: existing.trigger,
      enabled: false,
    });
  });

  it('renames while keeping the rest', () => {
    const updated = parseScheduleMutation({ name: 'Renamed' }, existing);
    expect(updated.name).toBe('Renamed');
    expect(updated.pipelinePath).toBe(existing.pipelinePath);
    expect(updated.trigger).toEqual(existing.trigger);
  });

  it('replaces the trigger when one is given', () => {
    const updated = parseScheduleMutation(
      { trigger: { type: 'cron', cron: '15 3 * * *' } },
      existing
    );
    expect(updated.trigger).toEqual({ type: 'cron', cron: '15 3 * * *' });
  });

  it('rejects a non-boolean enabled on update too', () => {
    expect(() => parseScheduleMutation({ enabled: 'false' }, existing)).toThrow(/enabled/);
  });
});

describe('schedule tenant scope', () => {
  const system = { id: 'nightly.report', pipelinePath: 'pipelines/daily-routine.json' };
  const tenantByPath = {
    id: 'tenant-acme-daily',
    pipelinePath: 'knowledge/confidential/acme/pipelines/daily.json',
  };
  const tenantById = { id: 'tenant-acme-x', pipelinePath: 'pipelines/daily-routine.json' };

  it('detects tenant binding from the pipeline path or the id prefix', () => {
    expect(scheduleTenantSlug(system)).toBeUndefined();
    expect(scheduleTenantSlug(tenantByPath)).toBe('acme');
    expect(scheduleTenantSlug(tenantById)).toBe('acme');
  });

  it('admits system schedules to every scope and tenant schedules only to theirs', () => {
    expect(scheduleAdmitsTenantScope(system, ['other'])).toBe(true);
    expect(scheduleAdmitsTenantScope(tenantByPath, 'all')).toBe(true);
    expect(scheduleAdmitsTenantScope(tenantByPath, ['acme'])).toBe(true);
    expect(scheduleAdmitsTenantScope(tenantByPath, ['other'])).toBe(false);
    expect(scheduleAdmitsTenantScope(tenantById, ['other'])).toBe(false);
  });
});
