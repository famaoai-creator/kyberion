/**
 * PG-06: readiness — which grants a kind of work still needs.
 *
 * A readiness profile (`readiness_profiles` in grant-capability-policy.json)
 * lists the capabilities one kind of work needs. Each one is evaluated by the
 * same gate the work itself passes through, so "ready" here means the gate
 * will allow it: meeting recording / voice through the participation
 * coordinator's consent check (read-only: no mission binding is recorded),
 * everything else through `resolveGrant`. Never throws for a capability;
 * an unknown profile throws.
 */
import { checkMeetingParticipationConsent } from '../meeting/meeting-participation-coordinator.js';
import {
  getGrantCapabilityPolicy,
  getGrantReadinessProfile,
  listGrantReadinessProfiles,
} from './grant-capability-policy.js';
import {
  resolveGrant,
  type GrantResolution,
  type GrantResolveContext,
  type GrantResolveDeps,
} from './grant-resolver.js';

export interface GrantReadinessItem {
  capability: string;
  required: boolean;
  note?: string;
  allowed: boolean;
  source?: GrantResolution['source'];
  grant_id?: string;
  reason?: string;
  remedy?: string;
}

export interface GrantReadinessReport {
  profile: string;
  description: string;
  /** Every required capability is allowed. */
  ready: boolean;
  /** Required capabilities that are not allowed. */
  missing: string[];
  items: GrantReadinessItem[];
}

export interface GrantReadinessDeps extends GrantResolveDeps {
  /** Override for tests: the meeting consent gate. */
  meetingConsent?: typeof checkMeetingParticipationConsent;
}

function evaluateMeetingConsent(
  purpose: 'recording' | 'voice',
  context: GrantResolveContext,
  deps: GrantReadinessDeps
): GrantResolution {
  const check = deps.meetingConsent ?? checkMeetingParticipationConsent;
  try {
    const result = check({
      ...(context.mission_id ? { mission_id: context.mission_id } : {}),
      ...(context.tenant_slug ? { tenant_slug: context.tenant_slug } : {}),
      purpose,
      ...(context.meeting ? { meeting: context.meeting } : {}),
      record_binding: false,
    });
    if (result.allowed) {
      return result.grant_id
        ? { allowed: true, source: 'standing', grant_id: result.grant_id }
        : { allowed: true, source: 'mission' };
    }
    const missionRemedy = `pnpm meeting:consent grant --mission ${context.mission_id ?? '<MISSION_ID>'}`;
    // The gate's reason ends with "| or: <remedy>"; the remedy is its own field here.
    const reason =
      result.reason && result.remedy
        ? result.reason.replace(` | or: ${result.remedy}`, '')
        : result.reason;
    return {
      allowed: false,
      ...(reason ? { reason } : {}),
      remedy: purpose === 'recording' && result.remedy ? result.remedy : missionRemedy,
    };
  } catch (err: unknown) {
    return {
      allowed: false,
      reason: `consent check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function evaluateCapability(
  capability: string,
  context: GrantResolveContext,
  deps: GrantReadinessDeps
): GrantResolution {
  if (capability === 'meeting.recording') return evaluateMeetingConsent('recording', context, deps);
  if (capability === 'meeting.voice') return evaluateMeetingConsent('voice', context, deps);
  return resolveGrant({ capability, context }, deps);
}

export function evaluateGrantReadiness(
  input: { profile: string; context: GrantResolveContext },
  deps: GrantReadinessDeps = {}
): GrantReadinessReport {
  const profile = getGrantReadinessProfile(input.profile);
  if (!profile) {
    const known = listGrantReadinessProfiles().join(', ') || '(none)';
    throw new Error(`[GRANT_READINESS] unknown profile ${input.profile}; known: ${known}`);
  }
  const items = profile.requirements.map((requirement): GrantReadinessItem => {
    const declared = getGrantCapabilityPolicy(requirement.capability);
    const resolution: GrantResolution = declared
      ? evaluateCapability(requirement.capability, input.context, deps)
      : { allowed: false, reason: `capability ${requirement.capability} is not declared` };
    return {
      capability: requirement.capability,
      required: requirement.required,
      ...(requirement.note ? { note: requirement.note } : {}),
      allowed: resolution.allowed,
      ...(resolution.source ? { source: resolution.source } : {}),
      ...(resolution.grant_id ? { grant_id: resolution.grant_id } : {}),
      ...(resolution.allowed || !resolution.reason ? {} : { reason: resolution.reason }),
      ...(resolution.allowed || !resolution.remedy ? {} : { remedy: resolution.remedy }),
    };
  });
  const missing = items
    .filter((item) => item.required && !item.allowed)
    .map((item) => item.capability);
  return {
    profile: input.profile,
    description: profile.description,
    ready: missing.length === 0,
    missing,
    items,
  };
}
