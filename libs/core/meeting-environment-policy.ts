import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';
import type { MeetingBriefInput, MeetingPurpose, MeetingRole } from './meeting-operations-profile.js';
import type { MeetingOperationsProfile } from './src/types/meeting-operations-profile.js';
import type { MeetingOperationsBrief } from './src/types/meeting-operations-brief.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const POLICY_PATH = pathResolver.knowledge('product/governance/meeting-environment-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/meeting-environment-policy.schema.json');

export type MeetingEnvironmentState =
  | 'required'
  | 'recommended'
  | 'optional'
  | 'blocked_by_authority'
  | 'not_needed';

export type MeetingEnvironmentItemKind =
  | 'browser'
  | 'audio'
  | 'ffmpeg'
  | 'stt'
  | 'tts'
  | 'voice_profile'
  | 'voice_consent'
  | 'camera'
  | 'screen_share';

export interface MeetingEnvironmentItem {
  kind: MeetingEnvironmentItemKind;
  state: MeetingEnvironmentState;
  reason: string;
  setup_hint?: string;
}

export interface MeetingEnvironmentPolicy {
  version: string;
  transport_modes: {
    speaking_allowed: 'realtime_voice';
    speaking_blocked: 'transcribe_first';
  };
  base_items: MeetingEnvironmentItem[];
  speaking: {
    explicit_patterns: string[];
    allowed_items: MeetingEnvironmentItem[];
    blocked_items: MeetingEnvironmentItem[];
  };
  camera: {
    explicit_patterns: string[];
    recommended_roles: MeetingRole[];
    recommended_purposes: MeetingPurpose[];
    required_item: MeetingEnvironmentItem;
    recommended_item: MeetingEnvironmentItem;
    not_needed_item: MeetingEnvironmentItem;
  };
  screen_share: {
    explicit_patterns: string[];
    recommended_patterns: string[];
    recommended_roles: MeetingRole[];
    recommended_purposes: MeetingPurpose[];
    required_item: MeetingEnvironmentItem;
    recommended_item: MeetingEnvironmentItem;
    not_needed_item: MeetingEnvironmentItem;
  };
  questions: {
    camera_recommended: string;
    screen_share_recommended: string;
    speaking_blocked: string;
  };
}

type MeetingEnvironmentSelection = MeetingOperationsBrief['environment'];

let validateFn: ValidateFunction | null = null;
let cachedPolicy: MeetingEnvironmentPolicy | null = null;
let cachedPolicyPath: string | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return validateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim(),
  );
}

export function validateMeetingEnvironmentPolicy(
  value: unknown,
  label = POLICY_PATH,
): MeetingEnvironmentPolicy {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid meeting environment policy at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as MeetingEnvironmentPolicy;
}

function loadPolicyFile(): MeetingEnvironmentPolicy | null {
  if (!safeExistsSync(POLICY_PATH)) return null;
  const parsed = JSON.parse(safeReadFile(POLICY_PATH, { encoding: 'utf8' }) as string);
  return validateMeetingEnvironmentPolicy(parsed, POLICY_PATH);
}

export function loadMeetingEnvironmentPolicy(): MeetingEnvironmentPolicy {
  if (cachedPolicy && cachedPolicyPath === POLICY_PATH) return cachedPolicy;
  const loaded = loadPolicyFile();
  if (!loaded) {
    throw new Error(`Meeting environment policy missing at ${POLICY_PATH}`);
  }
  cachedPolicy = loaded;
  cachedPolicyPath = POLICY_PATH;
  return cachedPolicy;
}

function normalizeSignalText(values: Array<string | undefined | null>): string {
  return values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase())
    .join(' ');
}

function signalIncludes(signalText: string, patterns: string[]): boolean {
  return patterns.some((pattern) => signalText.includes(pattern.toLowerCase()));
}

function cloneItem(item: MeetingEnvironmentItem): MeetingEnvironmentItem {
  return { ...item };
}

function addItems(target: MeetingEnvironmentItem[], items: MeetingEnvironmentItem[]): void {
  for (const item of items) {
    target.push(cloneItem(item));
  }
}

function selectScopeItem(
  scope: Pick<
    MeetingEnvironmentPolicy['camera'],
    'required_item' | 'recommended_item' | 'not_needed_item'
  >,
  state: 'required' | 'recommended' | 'not_needed',
): MeetingEnvironmentItem {
  if (state === 'required') return cloneItem(scope.required_item);
  if (state === 'recommended') return cloneItem(scope.recommended_item);
  return cloneItem(scope.not_needed_item);
}

function purposeMatches(inputPurpose: MeetingBriefInput['purpose'], purposes: MeetingPurpose[]): boolean {
  return purposes.includes((inputPurpose ? String(inputPurpose) : 'default') as MeetingPurpose);
}

function roleMatches(primaryRole: MeetingRole, roles: MeetingRole[]): boolean {
  return roles.includes(primaryRole);
}

function resolveScopeState(input: {
  explicitRequested: boolean;
  recommendedRequested: boolean;
  primaryRole: MeetingRole;
  purpose: MeetingBriefInput['purpose'];
  recommendedRoles: MeetingRole[];
  recommendedPurposes: MeetingPurpose[];
}): 'required' | 'recommended' | 'not_needed' {
  if (input.explicitRequested) return 'required';
  if (
    input.recommendedRequested ||
    (roleMatches(input.primaryRole, input.recommendedRoles) && purposeMatches(input.purpose, input.recommendedPurposes))
  ) {
    return 'recommended';
  }
  return 'not_needed';
}

export function resolveMeetingEnvironment(
  input: MeetingBriefInput,
  profile: MeetingOperationsProfile,
  primaryRole: MeetingRole,
  policy: MeetingEnvironmentPolicy = loadMeetingEnvironmentPolicy(),
): MeetingEnvironmentSelection {
  const signals = normalizeSignalText([
    input.meeting_title,
    input.meeting_url,
    input.platform,
    input.purpose,
    ...(input.agenda || []),
    ...(input.desired_outcomes || []),
    ...(input.own_tasks || []),
    ...(input.tracking_expectations || []),
    input.notes,
    ...(input.participants || []).flatMap((participant) => [
      participant.name,
      participant.channel_handle,
      participant.person_slug,
      participant.role_hint,
    ]),
  ]);

  const explicitSpeakingRequested = signalIncludes(signals, policy.speaking.explicit_patterns);
  const explicitCameraRequested = signalIncludes(signals, policy.camera.explicit_patterns);
  const explicitScreenShareRequested = signalIncludes(signals, policy.screen_share.explicit_patterns);
  const canSpeak = profile.facilitation_policy.ask_before_speaking === false;

  const items: MeetingEnvironmentItem[] = policy.base_items.map(cloneItem);

  if (canSpeak) {
    addItems(items, policy.speaking.allowed_items);
  } else if (explicitSpeakingRequested) {
    addItems(items, policy.speaking.blocked_items);
  }

  const cameraState = resolveScopeState({
    explicitRequested: explicitCameraRequested,
    recommendedRequested: false,
    primaryRole,
    purpose: input.purpose,
    recommendedRoles: policy.camera.recommended_roles,
    recommendedPurposes: policy.camera.recommended_purposes,
  });
  items.push(selectScopeItem(policy.camera, cameraState));

  const screenShareState = resolveScopeState({
    explicitRequested: explicitScreenShareRequested,
    recommendedRequested: signalIncludes(signals, policy.screen_share.recommended_patterns),
    primaryRole,
    purpose: input.purpose,
    recommendedRoles: policy.screen_share.recommended_roles,
    recommendedPurposes: policy.screen_share.recommended_purposes,
  });
  items.push(selectScopeItem(policy.screen_share, screenShareState));

  const questions: string[] = [];
  if (cameraState === 'recommended') {
    questions.push(policy.questions.camera_recommended);
  }
  if (screenShareState === 'recommended') {
    questions.push(policy.questions.screen_share_recommended);
  }
  if (explicitSpeakingRequested && !canSpeak) {
    questions.push(policy.questions.speaking_blocked);
  }

  return {
    transport_mode: canSpeak ? policy.transport_modes.speaking_allowed : policy.transport_modes.speaking_blocked,
    items,
    questions,
  };
}

export function resetMeetingEnvironmentPolicyCache(): void {
  cachedPolicy = null;
  cachedPolicyPath = null;
}
