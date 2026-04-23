import { afterEach, describe, expect, it } from 'vitest';
import * as pathResolver from './path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { collectVoiceSamples } from './voice-sample-collection.js';
import { resetVoiceSampleIngestionPolicyCache } from './voice-sample-ingestion-policy.js';

describe('voice-sample-collection', () => {
  const tmpDir = pathResolver.sharedTmp('voice-sample-collection-tests');
  const policyPath = `${tmpDir}/voice-sample-ingestion-policy.json`;
  const sample1 = `${tmpDir}/sample-01.wav`;
  const sample2 = `${tmpDir}/sample-02.wav`;

  afterEach(() => {
    safeRmSync(tmpDir, { recursive: true, force: true });
    safeRmSync(pathResolver.sharedTmp('voice-sample-collection'), { recursive: true, force: true });
    delete process.env.KYBERION_VOICE_SAMPLE_INGESTION_POLICY_PATH;
    resetVoiceSampleIngestionPolicyCache();
  });

  it('collects source files into governed staging and emits a manifest', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      policyPath,
      JSON.stringify({
        version: 'test',
        sample_limits: {
          min_samples: 1,
          max_samples: 10,
          min_sample_bytes: 10,
          max_sample_bytes: 1_000_000,
          allowed_extensions: ['wav'],
        },
        profile_rules: {
          allowed_tiers: ['personal', 'confidential'],
          require_unique_sample_paths: true,
          require_language_coverage: false,
          strict_personal_voice_registration: true,
        },
      }),
    );
    process.env.KYBERION_VOICE_SAMPLE_INGESTION_POLICY_PATH = policyPath;
    safeWriteFile(sample1, Buffer.from('12345678901234567890'));
    safeWriteFile(sample2, Buffer.from('abcdefghijklmnopqrstuvwxyz'));

    const result = collectVoiceSamples({
      action: 'collect_voice_samples',
      request_id: 'collect-1',
      profile_draft: {
        profile_id: 'me-ja',
        display_name: 'Me JA',
        tier: 'personal',
        languages: ['ja'],
        default_engine_id: 'open_voice_clone',
      },
      samples: [
        { sample_id: 's1', path: sample1, language: 'ja' },
        { sample_id: 's2', path: sample2, language: 'ja' },
      ],
    });

    expect(result.status).toBe('succeeded');
    expect(result.staged_samples).toHaveLength(2);
    expect(result.registration_candidate.samples[0]?.path).toContain('voice-sample-collection/collect-1');
    const manifest = JSON.parse(safeReadFile(result.collection_manifest_path, { encoding: 'utf8' }) as string) as {
      kind?: string;
      samples?: Array<{ staged_path?: string }>;
    };
    expect(manifest.kind).toBe('voice_sample_collection_manifest');
    expect(manifest.samples?.[0]?.staged_path).toContain('voice-sample-collection/collect-1');
  });

  it('rejects duplicate source paths when policy requires uniqueness', () => {
    safeMkdir(tmpDir, { recursive: true });
    safeWriteFile(
      policyPath,
      JSON.stringify({
        version: 'test',
        sample_limits: {
          min_samples: 1,
          max_samples: 10,
          min_sample_bytes: 10,
          max_sample_bytes: 1_000_000,
          allowed_extensions: ['wav'],
        },
        profile_rules: {
          allowed_tiers: ['personal', 'confidential'],
          require_unique_sample_paths: true,
          require_language_coverage: false,
          strict_personal_voice_registration: true,
        },
      }),
    );
    process.env.KYBERION_VOICE_SAMPLE_INGESTION_POLICY_PATH = policyPath;
    safeWriteFile(sample1, Buffer.from('12345678901234567890'));

    expect(() =>
      collectVoiceSamples({
        action: 'collect_voice_samples',
        request_id: 'collect-dup',
        samples: [
          { sample_id: 's1', path: sample1, language: 'ja' },
          { sample_id: 's2', path: sample1, language: 'ja' },
        ],
      }),
    ).toThrow(/duplicate sample path/u);
  });
});
