import * as path from 'node:path';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { safeJsonParse } from './validators.js';
import { getVoiceEngineRecord, listVoiceEngines } from './voice-engine-registry.js';
import { getVoiceProfileRegistry } from './voice-profile-registry.js';

export interface VoiceSampleIngestionPolicy {
  version: string;
  sample_limits: {
    min_samples: number;
    max_samples: number;
    min_sample_bytes: number;
    max_sample_bytes: number;
    allowed_extensions: string[];
  };
  profile_rules: {
    allowed_tiers: Array<'personal' | 'confidential' | 'public'>;
    require_unique_sample_paths: boolean;
    require_language_coverage: boolean;
    strict_personal_voice_registration: boolean;
  };
}

export interface VoiceProfileRegistrationRequest {
  action: 'register_voice_profile';
  request_id: string;
  profile: {
    profile_id: string;
    display_name: string;
    tier: 'personal' | 'confidential' | 'public';
    languages: string[];
    default_engine_id: string;
    notes?: string;
  };
  samples: Array<{
    sample_id: string;
    path: string;
    language?: string;
  }>;
  policy?: {
    strict_personal_voice?: boolean;
  };
}

export interface VoiceProfileRegistrationValidationResult {
  ok: boolean;
  violations: string[];
  summary: {
    sample_count: number;
    total_sample_bytes: number;
    strict_personal_voice: boolean;
  };
}

const DEFAULT_POLICY_PATH = pathResolver.knowledge('public/governance/voice-sample-ingestion-policy.json');

const FALLBACK_POLICY: VoiceSampleIngestionPolicy = {
  version: 'fallback',
  sample_limits: {
    min_samples: 3,
    max_samples: 20,
    min_sample_bytes: 4096,
    max_sample_bytes: 25 * 1024 * 1024,
    allowed_extensions: ['wav', 'aiff', 'mp3', 'ogg', 'm4a', 'flac'],
  },
  profile_rules: {
    allowed_tiers: ['personal', 'confidential'],
    require_unique_sample_paths: true,
    require_language_coverage: true,
    strict_personal_voice_registration: true,
  },
};

let cachedPolicyPath: string | null = null;
let cachedPolicy: VoiceSampleIngestionPolicy | null = null;

function getPolicyPath(): string {
  return process.env.KYBERION_VOICE_SAMPLE_INGESTION_POLICY_PATH?.trim() || DEFAULT_POLICY_PATH;
}

export function resetVoiceSampleIngestionPolicyCache(): void {
  cachedPolicyPath = null;
  cachedPolicy = null;
}

export function getVoiceSampleIngestionPolicy(): VoiceSampleIngestionPolicy {
  const policyPath = getPolicyPath();
  if (cachedPolicyPath === policyPath && cachedPolicy) return cachedPolicy;
  if (!safeExistsSync(policyPath)) {
    cachedPolicyPath = policyPath;
    cachedPolicy = FALLBACK_POLICY;
    return cachedPolicy;
  }
  try {
    const raw = safeReadFile(policyPath, { encoding: 'utf8' }) as string;
    const parsed = safeJsonParse<VoiceSampleIngestionPolicy>(raw, 'voice sample ingestion policy');
    cachedPolicyPath = policyPath;
    cachedPolicy = parsed;
    return parsed;
  } catch (error: any) {
    logger.warn(`[VOICE_SAMPLE_INGESTION_POLICY] Failed to load policy at ${policyPath}: ${error.message}`);
    cachedPolicyPath = policyPath;
    cachedPolicy = FALLBACK_POLICY;
    return cachedPolicy;
  }
}

export function validateVoiceProfileRegistration(
  request: VoiceProfileRegistrationRequest,
  policy: VoiceSampleIngestionPolicy = getVoiceSampleIngestionPolicy(),
): VoiceProfileRegistrationValidationResult {
  const violations: string[] = [];
  const strictPersonalVoice = request.policy?.strict_personal_voice ?? policy.profile_rules.strict_personal_voice_registration;
  const sampleCount = request.samples.length;

  if (!request.profile.profile_id.trim()) {
    violations.push('profile.profile_id must not be empty');
  }
  if (!request.profile.display_name.trim()) {
    violations.push('profile.display_name must not be empty');
  }
  if (!policy.profile_rules.allowed_tiers.includes(request.profile.tier)) {
    violations.push(`profile.tier ${request.profile.tier} is not allowed by policy`);
  }
  if (!(request.profile.languages || []).length) {
    violations.push('profile.languages must include at least one language');
  }

  const existingProfiles = new Set((getVoiceProfileRegistry().profiles || []).map((profile) => String(profile.profile_id || '')));
  if (existingProfiles.has(request.profile.profile_id)) {
    violations.push(`profile.profile_id already exists (${request.profile.profile_id})`);
  }

  const engines = new Set(listVoiceEngines('all').map((engine) => engine.engine_id));
  if (!engines.has(request.profile.default_engine_id)) {
    violations.push(`profile.default_engine_id is unknown (${request.profile.default_engine_id})`);
  } else {
    const engine = getVoiceEngineRecord(request.profile.default_engine_id);
    if (strictPersonalVoice && request.profile.tier === 'personal' && engine.kind !== 'voice_clone_service') {
      violations.push(`strict personal voice requires clone-capable engine, received ${engine.engine_id}`);
    }
  }

  if (sampleCount < policy.sample_limits.min_samples) {
    violations.push(`samples must include at least ${policy.sample_limits.min_samples} entries`);
  }
  if (sampleCount > policy.sample_limits.max_samples) {
    violations.push(`samples must include at most ${policy.sample_limits.max_samples} entries`);
  }

  const seenPaths = new Set<string>();
  const sampleLanguages = new Set<string>();
  let totalSampleBytes = 0;
  const allowedExtensions = new Set((policy.sample_limits.allowed_extensions || []).map((ext) => ext.toLowerCase()));
  for (const sample of request.samples) {
    const samplePath = String(sample.path || '').trim();
    if (!sample.sample_id?.trim()) {
      violations.push('every sample must define sample_id');
    }
    if (!samplePath) {
      violations.push(`sample ${sample.sample_id || 'unknown'} path must not be empty`);
      continue;
    }

    const resolvedPath = pathResolver.rootResolve(samplePath);
    if (policy.profile_rules.require_unique_sample_paths) {
      if (seenPaths.has(resolvedPath)) {
        violations.push(`duplicate sample path detected (${samplePath})`);
      }
      seenPaths.add(resolvedPath);
    }
    if (!safeExistsSync(resolvedPath)) {
      violations.push(`sample file does not exist (${samplePath})`);
      continue;
    }

    const ext = path.extname(samplePath).replace('.', '').toLowerCase();
    if (!allowedExtensions.has(ext)) {
      violations.push(`sample ${sample.sample_id || samplePath} extension .${ext} is not allowed`);
    }

    const bytes = (safeReadFile(resolvedPath, { encoding: null }) as Buffer).length;
    totalSampleBytes += bytes;
    if (bytes < policy.sample_limits.min_sample_bytes) {
      violations.push(`sample ${sample.sample_id || samplePath} is too small (${bytes} bytes)`);
    }
    if (bytes > policy.sample_limits.max_sample_bytes) {
      violations.push(`sample ${sample.sample_id || samplePath} exceeds max size (${bytes} bytes)`);
    }

    if (sample.language?.trim()) {
      sampleLanguages.add(sample.language.trim().toLowerCase());
    }
  }

  if (policy.profile_rules.require_language_coverage) {
    for (const language of request.profile.languages || []) {
      if (!sampleLanguages.has(language.toLowerCase())) {
        violations.push(`missing sample language coverage for ${language}`);
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    summary: {
      sample_count: sampleCount,
      total_sample_bytes: totalSampleBytes,
      strict_personal_voice: Boolean(strictPersonalVoice),
    },
  };
}
