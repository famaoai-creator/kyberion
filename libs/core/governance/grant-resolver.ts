/**
 * PG-03: one decision API over every kind of grant —
 * `resolveGrant({ capability, context })`.
 *
 * - standing_grant: the active, unrevoked grant of the tenant whose scope
 *   matches the meeting (series id OR normalized URL) — grant-store.ts.
 * - per_mission (`meeting.voice`): the mission's voice-consent.json, never a
 *   standing grant (speaking stays an explicit per-mission decision).
 * - os_permission: the macOS probe state of the probing host app (never prompts).
 *
 * Fail-closed: an unknown capability, an unreadable store, a broken / expired /
 * revoked / policy-violating record all resolve to `allowed: false` with a
 * remedy (the command that would make it pass).
 *
 * PG-04: a use inside a mission that a standing grant allowed is recorded in
 * the mission evidence (`evidence/grant-bindings.json`) by
 * {@link recordGrantMissionBinding}, so the mission's evidence stays complete.
 */
import { MissionEvidenceDoc } from '../mission/mission-evidence-doc.js';
import { nowIso } from '../foundation/time.js';
import { pathResolver } from '../path-resolver.js';
import {
  probeMacOSNativeAutomation,
  type MacOSNativeAutomationAvailability,
} from '../macos-native-automation.js';
import { evaluateMissionVoiceConsent } from '../voice/voice-consent.js';
import { getGrantCapabilityPolicy } from './grant-capability-policy.js';
import {
  grantStatusAt,
  listGrants,
  normalizeMeetingUrl,
  verifyGrantBasis,
  type GrantRecord,
} from './grant-store.js';

export type GrantSource = 'standing' | 'mission' | 'os' | 'legacy';

export interface GrantResolution {
  allowed: boolean;
  source?: GrantSource;
  grant_id?: string;
  reason?: string;
  /** What to run so the capability resolves (a command or a settings hint). */
  remedy?: string;
}

export interface GrantResolveContext {
  tenant_slug?: string;
  mission_id?: string;
  meeting?: { url?: string; series_id?: string };
  now?: Date;
}

export interface GrantResolveDeps {
  probe?: () => MacOSNativeAutomationAvailability;
}

const OS_SETTINGS_REMEDY: Record<'microphone' | 'camera' | 'screen_recording', string> = {
  microphone: 'System Settings > Privacy & Security > Microphone',
  camera: 'System Settings > Privacy & Security > Camera',
  screen_recording: 'System Settings > Privacy & Security > Screen & System Audio Recording',
};

function standingGrantRemedy(capability: string, context: GrantResolveContext): string {
  const tenant = context.tenant_slug ?? '<tenant>';
  const meeting = context.meeting?.series_id
    ? ` --meeting-series ${context.meeting.series_id}`
    : context.meeting?.url
      ? ` --meeting-url ${normalizeMeetingUrl(context.meeting.url) ?? '<url>'}`
      : ' --meeting-url <url>';
  return `pnpm kyberion grants grant --capability ${capability} --tenant ${tenant}${meeting} --purpose "<purpose>" --request-approval`;
}

function grantMatchesMeeting(
  record: GrantRecord,
  meeting: GrantResolveContext['meeting']
): boolean {
  if (!meeting) return false;
  const seriesId = meeting.series_id?.trim();
  if (seriesId && record.scope.meeting_series_ids?.includes(seriesId)) return true;
  const url = meeting.url ? normalizeMeetingUrl(meeting.url) : null;
  return Boolean(url && record.scope.meeting_urls?.includes(url));
}

/** Standing-grant lookup only (no legacy / adapter sources). */
export function resolveStandingGrant(
  capability: string,
  context: GrantResolveContext
): GrantResolution {
  let policy;
  try {
    policy = getGrantCapabilityPolicy(capability);
  } catch (err: unknown) {
    return {
      allowed: false,
      reason: `grant capability policy unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!policy) return { allowed: false, reason: `capability ${capability} is not declared` };
  if (policy.kind !== 'standing_grant') {
    return { allowed: false, reason: `capability ${capability} is not a standing grant` };
  }
  const remedy = standingGrantRemedy(capability, context);
  const tenant = context.tenant_slug?.trim();
  if (policy.scope_keys.includes('tenant_slug') && !tenant) {
    return {
      allowed: false,
      reason: `no tenant in context; a ${capability} standing grant is bound to a tenant`,
      remedy,
    };
  }
  if (
    policy.scope_keys.includes('meeting') &&
    !context.meeting?.series_id?.trim() &&
    !context.meeting?.url?.trim()
  ) {
    return {
      allowed: false,
      reason: `no meeting URL or series id in context; a ${capability} standing grant is bound to meetings`,
      remedy,
    };
  }
  let records: GrantRecord[];
  try {
    records = listGrants({ capability, ...(tenant ? { tenant_slug: tenant } : {}) });
  } catch (err: unknown) {
    return {
      allowed: false,
      reason: `standing grants unreadable: ${err instanceof Error ? err.message : String(err)}`,
      remedy,
    };
  }
  const now = context.now ?? new Date();
  const matching = records.filter(
    (record) =>
      record.scope.tenant_slug === tenant &&
      (!policy.scope_keys.includes('meeting') || grantMatchesMeeting(record, context.meeting))
  );
  const active = matching.find(
    (record) => grantStatusAt(record, now) === 'active' && verifyGrantBasis(record)
  );
  if (active) return { allowed: true, source: 'standing', grant_id: active.grant_id };
  if (matching.some((record) => grantStatusAt(record, now) === 'active')) {
    return {
      allowed: false,
      reason: `the ${capability} standing grant for this meeting no longer rests on a valid human approval`,
      remedy,
    };
  }
  const statuses = new Set(matching.map((record) => grantStatusAt(record, now)));
  const reason = statuses.has('revoked')
    ? `the ${capability} standing grant for this meeting was revoked`
    : statuses.has('expired')
      ? `the ${capability} standing grant for this meeting expired`
      : `no ${capability} standing grant covers this meeting for tenant ${tenant}`;
  return { allowed: false, reason, remedy };
}

function resolveOsPermission(
  probeKey: 'microphone' | 'camera' | 'screen_recording',
  deps: GrantResolveDeps
): GrantResolution {
  let probe: MacOSNativeAutomationAvailability;
  try {
    probe = (deps.probe ?? probeMacOSNativeAutomation)();
  } catch (err: unknown) {
    return {
      allowed: false,
      reason: `OS permission probe failed: ${err instanceof Error ? err.message : String(err)}`,
      remedy: 'pnpm kyberion permissions status',
    };
  }
  const state = probe[probeKey] ?? 'unknown';
  const host = probe.host_app ? ` (host app ${probe.host_app})` : '';
  if (state === 'granted') return { allowed: true, source: 'os' };
  if (state === 'not_determined') {
    return {
      allowed: false,
      source: 'os',
      reason: `${probeKey} permission not requested yet${host}`,
      remedy: `pnpm kyberion permissions warmup --only ${probeKey}`,
    };
  }
  if (state === 'denied') {
    return {
      allowed: false,
      source: 'os',
      reason: `${probeKey} permission denied${host}`,
      remedy: `${OS_SETTINGS_REMEDY[probeKey]} (enable the host app, then restart it)`,
    };
  }
  if (state === 'restricted') {
    return {
      allowed: false,
      source: 'os',
      reason: `${probeKey} permission restricted by a device policy${host}`,
      remedy: 'Ask the device administrator (MDM / Screen Time)',
    };
  }
  return {
    allowed: false,
    source: 'os',
    reason: `${probeKey} permission state is ${state}${probe.reason ? ` (${probe.reason})` : ''}`,
    remedy: 'pnpm kyberion permissions status',
  };
}

/**
 * Resolve whether `capability` is allowed in `context`, from whichever store
 * the capability's policy names. Never throws.
 */
export function resolveGrant(
  input: { capability: string; context: GrantResolveContext },
  deps: GrantResolveDeps = {}
): GrantResolution {
  const { capability, context } = input;
  let policy;
  try {
    policy = getGrantCapabilityPolicy(capability);
  } catch (err: unknown) {
    return {
      allowed: false,
      reason: `grant capability policy unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!policy) return { allowed: false, reason: `capability ${capability} is not declared` };

  if (policy.kind === 'os_permission') return resolveOsPermission(policy.probe_key, deps);

  if (policy.kind === 'per_mission') {
    const result = evaluateMissionVoiceConsent({
      missionId: context.mission_id,
      tenantSlug: context.tenant_slug,
      purpose: 'voice',
      ...(context.now ? { nowMs: context.now.getTime() } : {}),
    });
    if (result.allowed) return { allowed: true, source: 'mission' };
    return {
      allowed: false,
      source: 'mission',
      reason: result.reason,
      remedy: `pnpm meeting:consent grant --mission ${context.mission_id ?? '<MISSION_ID>'}`,
    };
  }

  // standing_grant: a mission's own voice-consent.json (legacy) still allows
  // recording; otherwise a matching standing grant.
  if (capability === 'meeting.recording' && context.mission_id) {
    const legacy = evaluateMissionVoiceConsent({
      missionId: context.mission_id,
      tenantSlug: context.tenant_slug,
      purpose: 'recording',
      ...(context.now ? { nowMs: context.now.getTime() } : {}),
    });
    if (legacy.allowed) return { allowed: true, source: 'legacy' };
    if (legacy.code === 'path_rejected') return { allowed: false, reason: legacy.reason };
  }
  return resolveStandingGrant(capability, context);
}

// ---------------------------------------------------------------------------
// Mission binding (PG-04)
// ---------------------------------------------------------------------------

export interface GrantMissionBinding {
  capability: string;
  grant_id: string;
  at: string;
}

export interface GrantMissionBindingsDoc {
  mission_id: string;
  bindings: GrantMissionBinding[];
}

function isGrantMissionBindingsDoc(doc: unknown): doc is GrantMissionBindingsDoc {
  if (!doc || typeof doc !== 'object') return false;
  const record = doc as Partial<GrantMissionBindingsDoc>;
  return typeof record.mission_id === 'string' && Array.isArray(record.bindings);
}

function bindingsDoc(missionId: string): MissionEvidenceDoc<GrantMissionBindingsDoc> {
  return new MissionEvidenceDoc<GrantMissionBindingsDoc>({
    mission_id: missionId,
    filename: 'grant-bindings.json',
    agent_id: 'grant-binding',
    validate: isGrantMissionBindingsDoc,
    schema: pathResolver.knowledge('product/schemas/grant-mission-bindings.schema.json'),
    catalog_id: 'grant-mission-bindings',
  });
}

/**
 * Record in the mission evidence that `grant_id` allowed `capability` here.
 * Idempotent per grant: a grant already bound to the mission is not re-recorded.
 * Throws when the mission does not exist (the evidence cannot be written).
 */
export function recordGrantMissionBinding(
  missionId: string,
  binding: { capability: string; grant_id: string; at?: string }
): { recorded: boolean; binding: GrantMissionBinding } {
  pathResolver.assertMissionIdArgument(missionId);
  const doc = bindingsDoc(missionId);
  const existing = doc.read();
  const prior = existing?.bindings.find((entry) => entry.grant_id === binding.grant_id);
  if (prior) return { recorded: false, binding: prior };
  if (doc.exists() && !existing) {
    throw new Error(
      `[GRANT_BINDING] ${missionId} evidence/grant-bindings.json is unreadable; refusing to overwrite it`
    );
  }
  const entry: GrantMissionBinding = {
    capability: binding.capability,
    grant_id: binding.grant_id,
    at: binding.at ?? nowIso(),
  };
  doc.write(
    { mission_id: missionId, bindings: [...(existing?.bindings ?? []), entry] },
    {
      action: 'grant.mission_bound',
      metadata: { capability: entry.capability, grant_id: entry.grant_id },
    }
  );
  return { recorded: true, binding: entry };
}

export function readGrantMissionBindings(missionId: string): GrantMissionBinding[] {
  return bindingsDoc(missionId).read()?.bindings ?? [];
}
