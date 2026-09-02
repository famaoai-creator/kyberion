import path from 'node:path';
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  generationSchedulePath,
  isGenerationScheduleDue,
  assertGenerationScheduleTenantRegistered,
  readGenerationSchedule,
  resolveGenerationScheduleDeliveryPaths,
  runGenerationScheduleAction,
} from './generation-scheduler.js';
import { pathResolver } from './path-resolver.js';

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
        new Date('2026-04-01T07:00:30.000+09:00')
      )
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
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(process.cwd(), 'knowledge/product/schemas/generation-schedule.schema.json')
    );

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
      JSON.stringify(validate.errors || [])
    ).toBe(true);
  });

  it('rejects invalid generation job records', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(process.cwd(), 'knowledge/product/schemas/generation-job.schema.json')
    );

    expect(
      validate({
        kind: 'generation-job',
        job_id: 'job-1',
        action: 'generate_music',
        status: 'submitted',
        request: {},
      })
    ).toBe(false);
  });

  it('defaults tenant delivery to its schedule namespace and rejects shared export paths', () => {
    const schedule = {
      kind: 'generation-schedule',
      schedule_id: 'tenant-image',
      enabled: true,
      scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'client-a' },
      trigger: { type: 'interval', interval_ms: 60_000 },
      job_template: {
        action: 'generate_image',
        params: { image_adf: { output: { format: 'png' } } },
      },
      execution_policy: { concurrency: 'skip_if_running' },
      created_at: '2026-03-01T00:00:00.000Z',
    } as any;

    expect(resolveGenerationScheduleDeliveryPaths(schedule).artifactDir).toContain(
      'active/shared/runtime/media-generation/artifacts/tenants/client-a/tenant-image'
    );
    expect(resolveGenerationScheduleDeliveryPaths(schedule).schedulePath).toContain(
      'active/shared/runtime/media-generation/schedules/tenants/client-a/tenant-image.json'
    );
    expect(generationSchedulePath('tenant-image', schedule.scope)).toContain(
      'active/shared/runtime/media-generation/schedules/tenants/client-a/tenant-image.json'
    );
    expect(() =>
      resolveGenerationScheduleDeliveryPaths({
        ...schedule,
        delivery_policy: { artifact_dir: 'active/shared/exports' },
      })
    ).toThrow(/GENERATION_SCOPE_PATH_DENIED/);
  });

  it('rejects schedule ids that could escape the shared registry path', () => {
    expect(() => generationSchedulePath('../escape')).toThrow(/GENERATION_SCHEDULE_ID_INVALID/);
  });

  it('rejects invalid persisted schedules and directories at the read boundary', () => {
    const invalidPath = generationSchedulePath('invalid-persisted-schedule');
    const directoryPath = pathResolver.sharedTmp('generation-scheduler-directory.json');
    try {
      safeWriteFile(
        invalidPath,
        JSON.stringify({
          kind: 'generation-schedule',
          schedule_id: 'invalid-persisted-schedule',
          enabled: true,
          trigger: { type: 'interval', interval_ms: 1000 },
          job_template: { action: 'generate_music', params: {} },
          execution_policy: { concurrency: 'skip_if_running' },
          created_at: '2026-03-01T00:00:00.000Z',
          unexpected: true,
        })
      );
      expect(() => readGenerationSchedule(invalidPath)).toThrow(
        'Invalid catalog generation-schedule'
      );

      safeMkdir(directoryPath, { recursive: true });
      expect(() => readGenerationSchedule(directoryPath)).toThrow(
        'schedule must be a regular file'
      );
    } finally {
      safeRmSync(invalidPath, { force: true });
      safeRmSync(directoryPath, { recursive: true, force: true });
    }
  });

  it('rejects external delivery paths for system schedules', () => {
    const schedule = {
      kind: 'generation-schedule',
      schedule_id: 'system-image',
      enabled: true,
      scope: { scope_kind: 'system', tier: 'public' },
      trigger: { type: 'interval', interval_ms: 60_000 },
      job_template: {
        action: 'generate_image',
        params: { image_adf: { output: { format: 'png' } } },
      },
      execution_policy: { concurrency: 'skip_if_running' },
      created_at: '2026-03-01T00:00:00.000Z',
      delivery_policy: { artifact_dir: '/tmp/external-generation-artifacts' },
    } as any;

    expect(() => resolveGenerationScheduleDeliveryPaths(schedule)).toThrow('RESOURCE_PATH_SCOPE');
  });

  it('requires an active tenant registry entry for tenant schedules', () => {
    const schedule = {
      scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'client-a' },
    } as any;
    expect(() =>
      assertGenerationScheduleTenantRegistered(schedule, {
        resolveTenant: () => {
          throw new Error('tenant is not active');
        },
      })
    ).toThrow('tenant is not active');
  });

  it('lists generation schedules without requiring the actuator path', async () => {
    await expect(runGenerationScheduleAction({ action: 'list' })).resolves.toEqual(
      expect.any(Array)
    );
  });

  it('ticks generation schedules safely when none are registered', async () => {
    await expect(runGenerationScheduleAction({ action: 'tick' })).resolves.toMatchObject({
      status: 'completed',
      results: expect.any(Array),
    });
  });
});
