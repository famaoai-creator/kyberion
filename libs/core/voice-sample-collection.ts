import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeCopyFileSync, safeExistsSync, safeMkdir, safeStat, safeWriteFile } from './secure-io.js';
import { getVoiceSampleIngestionPolicy, type VoiceSampleIngestionPolicy } from './voice-sample-ingestion-policy.js';

export interface VoiceSampleCollectionItem {
  sample_id: string;
  path: string;
  language?: string;
  note?: string;
}

export interface VoiceSampleCollectionProfileDraft {
  profile_id: string;
  display_name: string;
  tier: 'personal' | 'confidential' | 'public';
  languages: string[];
  default_engine_id: string;
  notes?: string;
}

export interface VoiceSampleCollectionRequest {
  action: 'collect_voice_samples';
  request_id: string;
  samples: VoiceSampleCollectionItem[];
  profile_draft?: VoiceSampleCollectionProfileDraft;
}

export interface VoiceSampleCollectionManifest {
  kind: 'voice_sample_collection_manifest';
  request_id: string;
  created_at: string;
  profile_draft?: VoiceSampleCollectionProfileDraft;
  samples: Array<VoiceSampleCollectionItem & {
    staged_path: string;
    bytes: number;
    extension: string;
  }>;
  summary: {
    sample_count: number;
    total_sample_bytes: number;
    collection_dir: string;
  };
}

export interface VoiceSampleCollectionResult {
  status: 'succeeded';
  action: 'collect_voice_samples';
  request_id: string;
  collection_manifest_path: string;
  collection_dir: string;
  staged_samples: VoiceSampleCollectionManifest['samples'];
  summary: VoiceSampleCollectionManifest['summary'];
  registration_candidate: {
    action: 'register_voice_profile';
    request_id: string;
    profile?: VoiceSampleCollectionProfileDraft;
    samples: Array<{ sample_id: string; path: string; language?: string }>;
  };
}

function normalizedExtension(filePath: string): string {
  return path.extname(filePath).replace(/^\./u, '').toLowerCase();
}

function validateCollectionRequest(
  input: VoiceSampleCollectionRequest,
  policy: VoiceSampleIngestionPolicy,
): void {
  if (!String(input.request_id || '').trim()) {
    throw new Error('collect_voice_samples requires request_id');
  }
  if (!Array.isArray(input.samples) || input.samples.length === 0) {
    throw new Error('collect_voice_samples requires at least one sample');
  }
  if (input.samples.length > policy.sample_limits.max_samples) {
    throw new Error(`sample count exceeds max_samples (${policy.sample_limits.max_samples})`);
  }
}

export function collectVoiceSamples(
  input: VoiceSampleCollectionRequest,
  policy: VoiceSampleIngestionPolicy = getVoiceSampleIngestionPolicy(),
): VoiceSampleCollectionResult {
  validateCollectionRequest(input, policy);
  const allowedExtensions = new Set(policy.sample_limits.allowed_extensions.map((ext) => ext.toLowerCase()));
  const seenSourcePaths = new Set<string>();
  const collectionDir = pathResolver.sharedTmp(`voice-sample-collection/${input.request_id}`);
  safeMkdir(collectionDir, { recursive: true });

  let totalSampleBytes = 0;
  const stagedSamples = input.samples.map((sample, index) => {
    const samplePath = String(sample.path || '').trim();
    if (!String(sample.sample_id || '').trim()) {
      throw new Error(`sample at index ${index} is missing sample_id`);
    }
    if (!samplePath) {
      throw new Error(`sample ${sample.sample_id} is missing path`);
    }
    if (policy.profile_rules.require_unique_sample_paths) {
      if (seenSourcePaths.has(samplePath)) {
        throw new Error(`duplicate sample path detected (${samplePath})`);
      }
      seenSourcePaths.add(samplePath);
    }
    if (!safeExistsSync(samplePath)) {
      throw new Error(`sample file does not exist (${samplePath})`);
    }
    const extension = normalizedExtension(samplePath);
    if (!allowedExtensions.has(extension)) {
      throw new Error(`sample ${sample.sample_id} extension .${extension} is not allowed`);
    }
    const stats = safeStat(samplePath);
    if (stats.size < policy.sample_limits.min_sample_bytes) {
      throw new Error(`sample ${sample.sample_id} is too small (${stats.size} bytes)`);
    }
    if (stats.size > policy.sample_limits.max_sample_bytes) {
      throw new Error(`sample ${sample.sample_id} exceeds max size (${stats.size} bytes)`);
    }

    totalSampleBytes += stats.size;
    const stagedPath = path.join(collectionDir, `${sample.sample_id}.${extension}`);
    safeCopyFileSync(samplePath, stagedPath);
    return {
      ...sample,
      staged_path: stagedPath,
      bytes: stats.size,
      extension,
    };
  });

  const manifest: VoiceSampleCollectionManifest = {
    kind: 'voice_sample_collection_manifest',
    request_id: input.request_id,
    created_at: new Date().toISOString(),
    ...(input.profile_draft ? { profile_draft: input.profile_draft } : {}),
    samples: stagedSamples,
    summary: {
      sample_count: stagedSamples.length,
      total_sample_bytes: totalSampleBytes,
      collection_dir: collectionDir,
    },
  };
  const manifestPath = path.join(collectionDir, 'collection-manifest.json');
  safeWriteFile(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    status: 'succeeded',
    action: 'collect_voice_samples',
    request_id: input.request_id,
    collection_manifest_path: manifestPath,
    collection_dir: collectionDir,
    staged_samples: stagedSamples,
    summary: manifest.summary,
    registration_candidate: {
      action: 'register_voice_profile',
      request_id: input.request_id,
      ...(input.profile_draft ? { profile: input.profile_draft } : {}),
      samples: stagedSamples.map((sample) => ({
        sample_id: sample.sample_id,
        path: sample.staged_path,
        ...(sample.language ? { language: sample.language } : {}),
      })),
    },
  };
}
