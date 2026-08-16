import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { normalizeEventScope } from './event-scope.js';
import {
  checkGenerationQuota,
  generationQuotaCounterPath,
  reserveGenerationQuota,
  releaseGenerationQuota,
  type GenerationQuotaPolicy,
} from './generation-quota.js';

const ROOT = path.join(process.cwd(), 'active/shared/tmp/generation-quota-tests');
const SCOPE = normalizeEventScope({ tier: 'confidential', tenant_slug: 'client-a' });
const POLICY: GenerationQuotaPolicy = {
  max_units_per_day: 3,
  warn_ratio: 0.66,
  operation_units: { generate_image: 1, generate_video: 2 },
  tenant_overrides: {},
};

describe('generation quota', () => {
  it('reserves atomically and blocks the next operation over the daily limit', () => {
    safeRmSync(ROOT, { recursive: true, force: true });
    const options = { rootDir: ROOT, policy: POLICY, now: '2026-08-16T00:00:00.000Z' };
    expect(reserveGenerationQuota(SCOPE, 'generate_image', options)).toMatchObject({
      allowed: true,
      projected: { units: 1 },
    });
    expect(reserveGenerationQuota(SCOPE, 'generate_video', options)).toMatchObject({
      allowed: true,
      level: 'warn',
      projected: { units: 3 },
    });
    expect(reserveGenerationQuota(SCOPE, 'generate_image', options)).toMatchObject({
      allowed: false,
      level: 'block',
      usage: { units: 3 },
    });
    expect(checkGenerationQuota(SCOPE, 'generate_image', options).projected.units).toBe(4);
    expect(releaseGenerationQuota(SCOPE, 'generate_video', options).projected.units).toBe(1);
    expect(checkGenerationQuota(SCOPE, 'generate_video', options).allowed).toBe(true);
    expect(generationQuotaCounterPath('client-a', options)).toContain('2026-08-16.json');
    safeRmSync(ROOT, { recursive: true, force: true });
  });

  it('does not charge system scope', () => {
    const result = reserveGenerationQuota(
      { tier: 'public', scope_kind: 'system' },
      'generate_video',
      { rootDir: ROOT, policy: POLICY, now: '2026-08-16T00:00:00.000Z' }
    );
    expect(result).toMatchObject({
      allowed: true,
      units: 0,
      reason: expect.stringContaining('system'),
    });
  });

  it('fails closed when the tenant counter is corrupt', () => {
    const options = { rootDir: ROOT, policy: POLICY, now: '2026-08-16T00:00:00.000Z' };
    const counterPath = generationQuotaCounterPath('client-a', options);
    safeMkdir(path.dirname(counterPath), { recursive: true });
    safeWriteFile(counterPath, '{not-json');

    expect(reserveGenerationQuota(SCOPE, 'generate_image', options)).toMatchObject({
      allowed: false,
      level: 'block',
      reason: expect.stringContaining('counter is invalid'),
    });
    expect(releaseGenerationQuota(SCOPE, 'generate_image', options)).toMatchObject({
      allowed: false,
      level: 'block',
    });
    safeRmSync(ROOT, { recursive: true, force: true });
  });
});
