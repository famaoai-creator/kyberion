import * as path from 'node:path';
import { getRegisteredEnvText } from './foundation/env.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';
import {
  getPersonalVoiceProfileRegistryPath,
  getVoiceProfileRegistry,
  getVoiceProfileRegistryPath,
  materializeVoiceProfileSampleRefs,
  type VoiceProfileRecord,
  type VoiceProfileRegistry,
  writeVoiceProfileRegistry,
} from './voice-profile-registry.js';

export interface VoiceProfileRegistrationReceipt {
  kind: 'voice_profile_registration_receipt';
  created_at: string;
  status: 'validated_pending_promotion' | 'promoted';
  request_id: string;
  profile: {
    profile_id: string;
    display_name: string;
    tier: 'personal' | 'confidential' | 'public';
    languages: string[];
    default_engine_id: string;
    notes?: string;
  };
  samples: Array<{ sample_id: string; path: string; language?: string }>;
  summary?: {
    sample_count: number;
    total_sample_bytes: number;
    strict_personal_voice: boolean;
  };
  policy_version?: string;
}

export interface PromoteVoiceProfileInput {
  receiptPath: string;
  approvedBy: string;
  targetStatus?: 'active' | 'shadow';
  setAsDefault?: boolean;
}

export interface PromoteVoiceProfileResult {
  status: 'succeeded';
  profile_id: string;
  registry_path: string;
  promotion_receipt_path: string;
  promoted_status: 'active' | 'shadow';
}

const REGISTRATION_RECEIPT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/voice-profile-registration-receipt.schema.json'
);
const VOICE_PROFILE_REGISTRY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/voice-profile-registry.schema.json'
);

function loadRegistrationReceipt(receiptPath: string): VoiceProfileRegistrationReceipt {
  const safeReceiptPath = assertSafeRepositoryPath(receiptPath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeReceiptPath)) {
    throw new Error(`Voice profile registration receipt not found: ${receiptPath}`);
  }
  const parsed = defineCatalog<VoiceProfileRegistrationReceipt>({
    id: 'voice-profile-registration-receipt',
    path: safeReceiptPath,
    schema: REGISTRATION_RECEIPT_SCHEMA_PATH,
  }).load();
  if (parsed.kind !== 'voice_profile_registration_receipt') {
    throw new Error(
      `Unsupported voice profile receipt kind: ${String((parsed as { kind?: string }).kind || 'unknown')}`
    );
  }
  if (parsed.status !== 'validated_pending_promotion') {
    throw new Error(
      `Voice profile receipt ${parsed.request_id} is not pending promotion (status=${parsed.status})`
    );
  }
  return parsed;
}

function buildPromotedProfile(
  receipt: VoiceProfileRegistrationReceipt,
  promotedStatus: 'active' | 'shadow',
  sampleRefs: string[]
): VoiceProfileRecord {
  return {
    profile_id: receipt.profile.profile_id,
    display_name: receipt.profile.display_name,
    tier: receipt.profile.tier,
    languages: receipt.profile.languages,
    sample_refs: sampleRefs,
    default_engine_id: receipt.profile.default_engine_id,
    status: promotedStatus,
    notes: receipt.profile.notes,
  };
}

function appendProfileToRegistry(input: {
  registry: VoiceProfileRegistry;
  profile: VoiceProfileRecord;
  setAsDefault: boolean;
}): VoiceProfileRegistry {
  if (input.registry.profiles.some((profile) => profile.profile_id === input.profile.profile_id)) {
    throw new Error(`Voice profile ${input.profile.profile_id} already exists in registry`);
  }
  return {
    ...input.registry,
    default_profile_id: input.setAsDefault
      ? input.profile.profile_id
      : input.registry.default_profile_id,
    profiles: [...input.registry.profiles, input.profile],
  };
}

function loadRegistryForPromotion(targetPath: string): VoiceProfileRegistry {
  const safeTargetPath = assertSafeRepositoryPath(targetPath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeTargetPath)) {
    return {
      version: '1.0.0',
      default_profile_id: getVoiceProfileRegistry().default_profile_id,
      profiles: [],
    };
  }
  return defineCatalog<VoiceProfileRegistry>({
    id: 'voice-profile-registry',
    path: safeTargetPath,
    schema: VOICE_PROFILE_REGISTRY_SCHEMA_PATH,
  }).load();
}

function resolvePromotionRegistryPath(tier: VoiceProfileRecord['tier']): string {
  if (getRegisteredEnvText('KYBERION_VOICE_PROFILE_REGISTRY_PATH')?.trim()) {
    return getVoiceProfileRegistryPath();
  }
  return tier === 'personal'
    ? getPersonalVoiceProfileRegistryPath()
    : getVoiceProfileRegistryPath();
}

function writePromotionReceipt(input: {
  receipt: VoiceProfileRegistrationReceipt;
  receiptPath: string;
  approvedBy: string;
  promotedProfile: VoiceProfileRecord;
  registryPath: string;
}): string {
  const targetDir = pathResolver.sharedTmp('voice-profile-promotion');
  const safeTargetDir = assertSafeRepositoryPath(targetDir, { allowMissingLeaf: true });
  safeMkdir(safeTargetDir, { recursive: true });
  const requestId = String(input.receipt.request_id || '').trim();
  if (!requestId || requestId === '.' || requestId === '..' || /[\\/]/u.test(requestId)) {
    throw new Error('Voice profile receipt request_id must be a single safe path segment');
  }
  const targetPath = assertSafeRepositoryPath(path.join(safeTargetDir, `${requestId}.json`), {
    allowMissingLeaf: true,
  });
  safeWriteFile(
    targetPath,
    JSON.stringify(
      {
        kind: 'voice_profile_promotion_receipt',
        promoted_at: nowIso(),
        request_id: input.receipt.request_id,
        approved_by: input.approvedBy,
        promoted_profile: input.promotedProfile,
        source_receipt_path: input.receiptPath,
        registry_path: input.registryPath,
      },
      null,
      2
    )
  );
  return targetPath;
}

export function promoteVoiceProfileFromReceipt(
  input: PromoteVoiceProfileInput
): PromoteVoiceProfileResult {
  const approvedBy = String(input.approvedBy || '').trim();
  if (!approvedBy) {
    throw new Error('Voice profile promotion requires approvedBy');
  }
  const promotedStatus = input.targetStatus || 'active';
  const receipt = loadRegistrationReceipt(input.receiptPath);
  const sampleRefs = materializeVoiceProfileSampleRefs(receipt.profile, receipt.samples);
  const promotedProfile = buildPromotedProfile(receipt, promotedStatus, sampleRefs);
  const targetRegistryPath = resolvePromotionRegistryPath(promotedProfile.tier);
  const nextRegistry = appendProfileToRegistry({
    registry: loadRegistryForPromotion(targetRegistryPath),
    profile: promotedProfile,
    setAsDefault: Boolean(input.setAsDefault),
  });
  const registryPath = writeVoiceProfileRegistry(nextRegistry, targetRegistryPath);
  const promotionReceiptPath = writePromotionReceipt({
    receipt,
    receiptPath: input.receiptPath,
    approvedBy,
    promotedProfile,
    registryPath,
  });
  return {
    status: 'succeeded',
    profile_id: promotedProfile.profile_id,
    registry_path: registryPath,
    promotion_receipt_path: promotionReceiptPath,
    promoted_status: promotedStatus,
  };
}
