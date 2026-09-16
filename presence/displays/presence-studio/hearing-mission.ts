// HT-03 (2nd half): pure mapping from a decided hearing record to the
// governed mission-creation contract — see
// docs/developer/improvement-plans-2026-08/FRONT_DESK_HEARING_TRAINING_PLAN_2026-09-14.ja.md
// §2.2 / HT-03 and FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md §2.5 principle 4
// (decisions are human-only, `decided_by = user:<member_id>`).
//
// This module is deliberately dependency-light and side-effect-free (no
// secure-io, no process exec, no @agent/core catalog loaders beyond `t`):
// `hearing-mission-routes.ts` is the only caller that touches disk/child
// processes. Two shapes are intentionally duplicated here rather than
// imported, mirroring `scripts/lib/decided-by-args.ts`'s own stated reason
// ("does not depend on that in-flight work"):
//   - `MissionBrief` / the mission-brief schema path: the canonical type
//     lives in `scripts/mission-alignment-gate/mission-brief.ts`, but a
//     front-desk surface must never import from `scripts/**` (governed CLIs
//     are invoked as built subprocesses, never as library code — see
//     `hearing-mission-routes.ts`'s module doc). The JSON Schema at
//     `knowledge/product/schemas/mission-brief.schema.json` is the single
//     source of truth either side validates against.
//   - the `--decided-by` id grammar (`user:<member-id>`) from
//     `scripts/lib/decided-by-args.ts`, and the mission id grammar from
//     `libs/core/mission-creation.ts`'s `assertValidMissionId` — both are
//     narrow, stable regexes duplicated here for the same boundary reason.
import { createHash } from 'node:crypto';
import { defineCatalog } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import type { HearingRecord } from './hearing.js';

// -- Mission brief (duplicated shape; see module doc) -----------------------

export interface MissionBriefFlowStep {
  step?: string | number;
  title?: string;
  detail?: string;
  pipeline?: string;
}

export interface MissionBriefRisk {
  risk?: string;
  level?: string | number;
  mitigation?: string;
}

export interface MissionBriefRole {
  who?: string;
  role?: string;
}

export interface MissionBrief {
  missionId?: string;
  title?: string;
  intent?: string;
  persona?: string;
  tier?: 'personal' | 'confidential' | 'public' | string;
  sovereignSwitch?: 'governance-first' | 'autonomous-yolo' | string;
  victoryConditions?: string[];
  scope?: { in?: string[]; out?: string[] };
  flow?: MissionBriefFlowStep[];
  roles?: MissionBriefRole[];
  deliverables?: string[];
  risks?: MissionBriefRisk[];
  openItems?: string[];
  gate?: {
    sudoGate?: string | boolean;
    riskLevel?: string | number;
    approvalRequired?: boolean;
  };
  estimate?: { effort?: string; cost?: string };
  projectId?: string;
  projectPath?: string;
  trackId?: string;
  trackType?: string;
  lifecycleModel?: string;
}

const MISSION_BRIEF_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-brief.schema.json'
);

const missionBriefCatalog = defineCatalog<MissionBrief>({
  id: 'hearing-mission-brief',
  // Never loaded from this path — `.validate()` only uses it to label a
  // schema-violation error message. The brief is written to its real mission
  // evidence path by `hearing-mission-routes.ts` via secure-io, not by this
  // pure module.
  path: 'presence-studio/hearing-mission-brief',
  schema: MISSION_BRIEF_SCHEMA_PATH,
});

/** Validate a brief against `mission-brief.schema.json` before it is trusted. */
export function validateHearingMissionBrief(brief: MissionBrief): MissionBrief {
  return missionBriefCatalog.validate(brief);
}

// -- Mission id ---------------------------------------------------------

// Mirrors `libs/core/mission-creation.ts`'s `MISSION_ID_PATTERN` (see module
// doc for why this is a duplicate, not an import).
const MISSION_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,63}$/;

export function assertHearingMissionId(missionId: string): void {
  if (!MISSION_ID_PATTERN.test(missionId)) {
    throw new Error(
      `[HEARING_MISSION_ID_INVALID] '${missionId}' must match ${MISSION_ID_PATTERN.source}`
    );
  }
}

/**
 * Stable per hearing session: the same session always maps to the same
 * mission id, so re-running the handoff (idempotency) or retrying after a
 * transient failure never mints a second mission for one hearing.
 */
export function hearingMissionId(record: Pick<HearingRecord, 'session_id'>): string {
  const digest = createHash('sha256')
    .update(record.session_id, 'utf8')
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
  const missionId = `MSN-HEARING-${digest}`;
  assertHearingMissionId(missionId);
  return missionId;
}

// -- Brief construction ---------------------------------------------------

const TENANT_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

export interface HearingMissionMember {
  /** `user:<member_id>` — human-only, per FD-10 principle 4. */
  id: string;
  display_name?: string;
  role?: 'owner' | 'approver' | 'viewer';
}

export interface HearingRecordToMissionBriefOptions {
  locale: SupportedLocale;
  tenantSlug: string;
  member: HearingMissionMember;
}

function requirementAnswer(record: HearingRecord, requirementId: string): string {
  return record.requirements.find((item) => item.id === requirementId)?.answer?.trim() || '';
}

function requirementLabel(
  record: HearingRecord,
  requirementId: string,
  locale: SupportedLocale
): string {
  const requirement = record.requirements.find((item) => item.id === requirementId);
  return requirement ? catalogT(requirement.label_key as VocabularyKey, undefined, locale) : '';
}

/**
 * Map a fully-answered, decided hearing record onto a draft `MissionBrief`.
 * Every fixed label comes from the hearing record's own `label_key`s (the
 * `front_desk:hearing_req_*` vocabulary already resolved per-locale — see
 * `hearing.ts`'s `WEB_APP_HEARING_SCENARIO`), never inline copy. The
 * free-form values (audience/problem/... answers) are the operator's own
 * words, carried through unchanged.
 */
export function hearingRecordToMissionBrief(
  record: HearingRecord,
  options: HearingRecordToMissionBriefOptions
): MissionBrief {
  if (!TENANT_SLUG_PATTERN.test(options.tenantSlug)) {
    throw new Error(
      `[HEARING_MISSION_INVALID] tenantSlug must match ${TENANT_SLUG_PATTERN.source}`
    );
  }
  const { locale } = options;
  const answer = (id: string) => requirementAnswer(record, id);
  const label = (id: string) => requirementLabel(record, id, locale);

  const problem = answer('problem');
  const audience = answer('audience');
  const success = answer('success');
  const coreFlow = answer('core_flow');
  const content = answer('content');
  const constraints = answer('constraints');
  const visualDirection = answer('visual_direction');

  if (!problem) {
    throw new Error(
      '[HEARING_MISSION_INCOMPLETE] the hearing record has no problem answer to summarize as the mission goal'
    );
  }

  const title = problem.length > 160 ? `${problem.slice(0, 157).trimEnd()}…` : problem;
  const intent = [
    audience ? `${label('audience')}: ${audience}` : undefined,
    `${label('problem')}: ${problem}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');

  const scopeIn = [
    coreFlow ? `${label('core_flow')}: ${coreFlow}` : undefined,
    content ? `${label('content')}: ${content}` : undefined,
    visualDirection ? `${label('visual_direction')}: ${visualDirection}` : undefined,
  ].filter((line): line is string => Boolean(line));
  const scopeOut = constraints ? [`${label('constraints')}: ${constraints}`] : [];

  const deliverables = [
    content ? `${label('content')}: ${content}` : title,
    `${catalogT('front_desk:hearing_canvas_frame_title', undefined, locale)} (${record.session_id})`,
  ];

  const brief: MissionBrief = {
    missionId: hearingMissionId(record),
    title,
    intent,
    tier: 'confidential',
    ...(success ? { victoryConditions: [success] } : {}),
    scope: {
      in: scopeIn,
      ...(scopeOut.length > 0 ? { out: scopeOut } : {}),
    },
    deliverables,
    roles: [{ who: options.member.display_name || options.member.id }],
  };

  return validateHearingMissionBrief(brief);
}

// -- mission_controller.js `create` argv -----------------------------------

// Mirrors `scripts/lib/decided-by-args.ts`'s `DECIDED_BY_ID_PATTERN` (see
// module doc for why this is a duplicate, not an import).
const DECIDED_BY_ID_PATTERN = /^user:[a-z][a-z0-9-]{1,30}$/;

export interface BuildHearingMissionCreateArgsInput {
  missionId: string;
  brief: MissionBrief;
  tenantSlug: string;
  /** Tenant-scoped hearing handoffs are always confidential, never personal. */
  tier: 'confidential';
  decidedBy: HearingMissionMember;
}

/**
 * Build the positional + named argv for `mission_controller.js create`,
 * exactly as `hearing-mission-routes.ts` passes it to `safeExecResult`
 * (prefixed with the controller's relative script path — see
 * `scripts/mission_controller.ts`'s `buildHelpText()` `create` grammar).
 */
export function buildHearingMissionCreateArgs(input: BuildHearingMissionCreateArgsInput): string[] {
  assertHearingMissionId(input.missionId);
  if (input.tier !== 'confidential') {
    throw new Error(
      '[HEARING_MISSION_TIER_INVALID] hearing mission handoff is tenant work and must use --tier confidential, never personal'
    );
  }
  if (!TENANT_SLUG_PATTERN.test(input.tenantSlug)) {
    throw new Error(
      `[HEARING_MISSION_INVALID] tenantSlug must match ${TENANT_SLUG_PATTERN.source}`
    );
  }
  if (!DECIDED_BY_ID_PATTERN.test(input.decidedBy.id)) {
    throw new Error(
      `[HEARING_MISSION_INVALID] decidedBy.id must match ${DECIDED_BY_ID_PATTERN.source} — decisions are recorded for human members only`
    );
  }
  const goal = input.brief.title?.trim();
  if (!goal) {
    throw new Error('[HEARING_MISSION_INVALID] brief.title is required to build --goal');
  }
  const successCondition = input.brief.victoryConditions?.[0]?.trim();

  return [
    'create',
    input.missionId,
    '--tier',
    input.tier,
    '--tenant-slug',
    input.tenantSlug,
    '--goal',
    goal,
    ...(successCondition ? ['--success-condition', successCondition] : []),
    '--decided-by',
    input.decidedBy.id,
    ...(input.decidedBy.display_name ? ['--decided-by-name', input.decidedBy.display_name] : []),
    ...(input.decidedBy.role ? ['--decided-by-role', input.decidedBy.role] : []),
  ];
}
