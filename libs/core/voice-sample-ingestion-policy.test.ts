import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  getVoiceSampleIngestionPolicy,
  _resetVoiceSampleIngestionPolicyCacheForTests,
  validateVoiceProfileRegistration,
} from './voice-sample-ingestion-policy.js';

describe('voice sample ingestion policy', () => {
  const tmpDir = pathResolver.sharedTmp('voice-sample-ingestion-policy-tests');
  const overridePath = `${tmpDir}/voice-sample-ingestion-policy.json`;
  const samplePath = `${tmpDir}/sample-01.wav`;
  const samplePath2 = `${tmpDir}/sample-02.wav`;
  const samplePath3 = `${tmpDir}/sample-03.wav`;

  afterEach(() => {
    safeRmSync(tmpDir, { recursive: true, force: true });
    delete process.env.KYBERION_VOICE_SAMPLE_INGESTION_POLICY_PATH;
    _resetVoiceSampleIngestionPolicyCacheForTests();
  });

  it('loads override policy files', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      overridePath,
      JSON.stringify({
        version: 'test',
        sample_limits: {
          min_samples: 1,
          max_samples: 10,
          min_sample_bytes: 10,
          max_sample_bytes: 1000000,
          allowed_extensions: ['wav'],
        },
        profile_rules: {
          allowed_tiers: ['personal'],
          require_unique_sample_paths: true,
          require_language_coverage: false,
          strict_personal_voice_registration: false,
        },
      })
    );
    process.env.KYBERION_VOICE_SAMPLE_INGESTION_POLICY_PATH = overridePath;
    const policy = getVoiceSampleIngestionPolicy();
    expect(policy.version).toBe('test');
    expect(policy.sample_limits.min_samples).toBe(1);
  });

  it('fails closed when an override fails schema validation', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(overridePath, JSON.stringify({ version: 'invalid' }));
    process.env.KYBERION_VOICE_SAMPLE_INGESTION_POLICY_PATH = overridePath;

    expect(() => getVoiceSampleIngestionPolicy()).toThrow(
      /Invalid catalog voice-sample-ingestion-policy/
    );
  });

  it('rejects policy overrides that traverse a symbolic link', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(overridePath, JSON.stringify({ version: 'test' }));
    const linkedPath = `${tmpDir}/linked-policy.json`;
    fs.symlinkSync(overridePath, linkedPath);
    process.env.KYBERION_VOICE_SAMPLE_INGESTION_POLICY_PATH = linkedPath;

    expect(() => getVoiceSampleIngestionPolicy()).toThrow('[RESOURCE_PATH_SYMLINK]');
  });

  it('blocks strict personal registration when engine is not clone-capable', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      overridePath,
      JSON.stringify({
        version: 'test',
        sample_limits: {
          min_samples: 3,
          max_samples: 10,
          min_sample_bytes: 10,
          max_sample_bytes: 1000000,
          allowed_extensions: ['wav'],
        },
        profile_rules: {
          allowed_tiers: ['personal', 'confidential'],
          require_unique_sample_paths: true,
          require_language_coverage: true,
          strict_personal_voice_registration: true,
        },
      })
    );
    process.env.KYBERION_VOICE_SAMPLE_INGESTION_POLICY_PATH = overridePath;
    safeWriteFile(samplePath, Buffer.from('12345678901234567890'));
    safeWriteFile(samplePath2, Buffer.from('12345678901234567890'));
    safeWriteFile(samplePath3, Buffer.from('12345678901234567890'));

    const result = validateVoiceProfileRegistration({
      action: 'register_voice_profile',
      request_id: 'req-strict',
      profile: {
        profile_id: 'personal-voice-req-strict',
        display_name: 'Personal Voice Strict',
        tier: 'personal',
        languages: ['ja'],
        default_engine_id: 'local_say',
      },
      samples: [
        { sample_id: 's1', path: samplePath, language: 'ja' },
        { sample_id: 's2', path: samplePath2, language: 'ja' },
        { sample_id: 's3', path: samplePath3, language: 'ja' },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.violations.join(' ')).toContain('clone-capable');
  });

  it('validates registration samples against policy limits', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      overridePath,
      JSON.stringify({
        version: 'test',
        sample_limits: {
          min_samples: 3,
          max_samples: 10,
          min_sample_bytes: 10,
          max_sample_bytes: 1000000,
          allowed_extensions: ['wav'],
        },
        profile_rules: {
          allowed_tiers: ['personal', 'confidential'],
          require_unique_sample_paths: true,
          require_language_coverage: true,
          strict_personal_voice_registration: false,
        },
      })
    );
    process.env.KYBERION_VOICE_SAMPLE_INGESTION_POLICY_PATH = overridePath;
    safeWriteFile(samplePath, Buffer.from('12345678901234567890'));
    safeWriteFile(samplePath2, Buffer.from('12345678901234567890'));
    safeWriteFile(samplePath3, Buffer.from('12345678901234567890'));

    const result = validateVoiceProfileRegistration({
      action: 'register_voice_profile',
      request_id: 'req-1',
      profile: {
        profile_id: 'personal-voice-req-1',
        display_name: 'Personal Voice Req 1',
        tier: 'personal',
        languages: ['ja'],
        default_engine_id: 'open_voice_clone',
      },
      samples: [
        { sample_id: 's1', path: samplePath, language: 'ja' },
        { sample_id: 's2', path: samplePath2, language: 'ja' },
        { sample_id: 's3', path: samplePath3, language: 'ja' },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.summary.sample_count).toBe(3);
    expect(result.summary.total_sample_bytes).toBeGreaterThan(0);
  });
});
