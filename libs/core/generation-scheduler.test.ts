import path from 'node:path';
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from './schema-loader.js';
import { isGenerationScheduleDue } from './generation-scheduler.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('generation scheduler', () => {
  it('matches simple cron schedules once per matching minute', () => {
    const schedule = {
      kind: 'generation-schedule',
      schedule_id: 'monthly',
      enabled: true,
      trigger: { type: 'cron', cron: '0 7 1 * *', timezone: 'Asia/Tokyo' },
      job_template: { action: 'generate_music', params: {} },
      execution_policy: { concurrency: 'skip_if_running' },
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T06:59:00.000Z',
    } as any;

    expect(isGenerationScheduleDue(schedule, new Date('2026-04-01T07:00:00.000+09:00'))).toBe(true);
    expect(
      isGenerationScheduleDue(
        { ...schedule, last_submitted_at: '2026-04-01T07:00:00.000+09:00' },
        new Date('2026-04-01T07:00:30.000+09:00'),
      ),
    ).toBe(false);
  });

  it('matches interval schedules based on elapsed milliseconds', () => {
    const schedule = {
      kind: 'generation-schedule',
      schedule_id: 'interval',
      enabled: true,
      trigger: { type: 'interval', interval_ms: 60_000 },
      job_template: { action: 'generate_music', params: {} },
      execution_policy: { concurrency: 'skip_if_running' },
      created_at: '2026-03-22T00:00:00.000Z',
      updated_at: '2026-03-22T00:00:00.000Z',
    } as any;

    expect(isGenerationScheduleDue(schedule, new Date('2026-03-22T00:00:30.000Z'))).toBe(false);
    expect(isGenerationScheduleDue(schedule, new Date('2026-03-22T00:01:00.000Z'))).toBe(true);
  });

  it('emits generation schedule records that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(process.cwd(), 'knowledge/public/schemas/generation-schedule.schema.json'));

    expect(
      validate({
        kind: 'generation-schedule',
        schedule_id: 'monthly',
        enabled: true,
        trigger: { type: 'cron', cron: '0 7 1 * *', timezone: 'Asia/Tokyo' },
        job_template: { action: 'generate_music', params: {} },
        execution_policy: { concurrency: 'skip_if_running' },
        created_at: '2026-03-01T00:00:00.000Z',
      }),
      JSON.stringify(validate.errors || []),
    ).toBe(true);
  });

  it('rejects invalid generation job records', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(process.cwd(), 'knowledge/public/schemas/generation-job.schema.json'));

    expect(
      validate({
        kind: 'generation-job',
        job_id: 'job-1',
        action: 'generate_music',
        status: 'submitted',
        request: {},
      }),
    ).toBe(false);
  });
});
