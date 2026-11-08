/**
 * HT-03 (2nd half): hand a decided hearing record off to the governed
 * mission/alignment pipeline, framework neutral so every surface serving
 * `POST /api/hearing/:session/handoff` runs the same steps (Studio, Concierge).
 * See docs/developer/improvement-plans-2026-08/FRONT_DESK_HEARING_TRAINING_PLAN_2026-09-14.ja.md
 * §2.2 / HT-03 and FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md §2.5.
 *
 * This module NEVER imports `scripts/**` — mission state changes only ever
 * go through `scripts/mission_controller.ts`, and the alignment gate only
 * ever opens through `scripts/mission_alignment_request.ts` (AGENTS.md §1
 * invariant). Both are invoked as built subprocesses via `safeExecResult` —
 * never as library imports. `hearing-mission.ts` (pure) builds the brief and
 * the `create` argv.
 */
import { nowIso } from '../foundation/time.js';
import { t as catalogT } from '../localization/t.js';
import type { SupportedLocale } from '../foundation/locale-normalize.js';
import { buildExecutionEnv, withExecutionContext } from '../authority.js';
import { resolveFrontDeskMenu, readFrontDeskSurfaceUrls } from './front-desk-nav.js';
import { frontDeskRoleFromViewerScope } from './front-desk-identity.js';
import type { MissionState } from '../mission/mission-types.js';
import { eventScopeFromRecord } from '../event/event-scope.js';
import { findHearingScenario } from './hearing-scenario-catalog.js';
import { pathResolver, findMissionPath } from '../path-resolver.js';
import { loadState } from '../mission/mission-state.js';
import {
  assertSafeRepositoryPath,
  safeExecResult,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from '../secure-io.js';
import { listApprovalRequests } from '../governance/approval-store.js';
import {
  assertHearingEditable,
  HearingConflictError,
  HearingOperationError,
  assertHearingHandoffReplay,
} from './hearing-runtime.js';
import { HearingScopeError } from './hearing-scope.js';
import { assertHearingHandoffSnapshot } from './hearing-handoff-snapshot.js';
import type { HearingDecidedBy, HearingRecord } from './hearing.js';
import type { HearingMissionHandoffFields } from './hearing-completion.js';
import {
  buildHearingMissionCreateArgs,
  hearingRecordToMissionBrief,
  type HearingMissionMember,
  type MissionBrief,
} from './hearing-mission.js';
import {
  assertHearingLedgerServed,
  HearingLedgerUnavailableError,
  hearingQueryLocale,
  parseHearingRequestBody,
  resolveHearingMember,
  type HearingHandoffDestination,
  type HearingQuery,
  type HearingRouteContext,
  type HearingRouteResult,
} from './hearing-route-context.js';

const CONTROLLER_RELATIVE = 'dist/scripts/mission_controller.js';
const ALIGNMENT_REQUEST_RELATIVE = 'dist/scripts/mission_alignment_request.js';

export type HearingRecordWithMissionHandoff = HearingRecord & HearingMissionHandoffFields;

/** A refusal of the mission hand-off with its own status (400/403/409/502/503). */
export class HearingMissionRequestError extends Error {
  constructor(
    public readonly status: 400 | 403 | 409 | 502 | 503,
    message: string
  ) {
    super(message);
  }
}

function hearingMissionSessionId(raw: unknown): string {
  const sessionId = String(raw || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u.test(sessionId)) {
    throw new HearingMissionRequestError(400, 'Invalid hearing session id.');
  }
  return sessionId;
}

/** The status of a refused hand-off: conflict 409, its own statuses, the
 * surface's viewer refusal, anything else 500. */
export function hearingMissionErrorStatus(
  error: unknown,
  viewerErrorStatus: (error: unknown) => number | undefined
): number {
  if (error instanceof HearingConflictError) return 409;
  if (
    error instanceof HearingMissionRequestError ||
    error instanceof HearingLedgerUnavailableError ||
    error instanceof HearingOperationError ||
    error instanceof HearingScopeError
  )
    return error.status;
  return viewerErrorStatus(error) ?? 500;
}

function assertGovernedScriptBuilt(scriptPath: string, label: string): void {
  let ready = false;
  try {
    const safePath = assertSafeRepositoryPath(scriptPath, { allowMissingLeaf: true });
    ready = safeExistsSync(safePath) && safeLstat(safePath).isFile();
  } catch {
    ready = false;
  }
  if (!ready) {
    throw new HearingMissionRequestError(503, `The ${label} build is missing: ${scriptPath}`);
  }
}

function buildDecideNextAction(locale: SupportedLocale, ctx: HearingRouteContext) {
  const scope = ctx.viewer;
  const item = resolveFrontDeskMenu({
    currentSurface: ctx.currentSurface,
    urls: readFrontDeskSurfaceUrls(),
    role: frontDeskRoleFromViewerScope(scope),
  }).find((candidate) => candidate.id === 'inbox');
  if (!item?.allowed) throw new HearingScopeError('hearing_scope_unavailable');
  // A destination hosted on the current surface is relative ('/inbox' on
  // Concierge); it stays relative. Another surface's is an absolute URL.
  const relativeBase = 'http://hearing.invalid';
  const relative = item.href.startsWith('/') && !item.href.startsWith('//');
  const url = relative ? new URL(item.href, relativeBase) : new URL(item.href);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new HearingScopeError('hearing_scope_unavailable');
  for (const [key, values] of [
    ['tenant', scope.tenantSlugs],
    ['organizationId', scope.organizationIds],
    ['projectId', scope.projectIds],
  ] as const) {
    url.searchParams.delete(key);
    if (values === 'all') continue;
    if (values.length !== 1) throw new HearingScopeError('hearing_scope_unavailable');
    url.searchParams.set(key, values[0]);
  }
  const href = relative ? url.pathname + url.search + url.hash : url.href;
  return {
    kind: 'alignment_review' as const,
    label_key: 'front_desk:hearing_open_decide' as const,
    label: catalogT('front_desk:hearing_open_decide', undefined, locale),
    href,
  };
}

/** Prefer the id the alignment-request CLI printed via `--json`; fall back to
 * reading the approval store directly (the CLI's own reuse-on-rerun path
 * still leaves exactly one pending record per `correlationId`). */
function resolveAlignmentRequestId(
  missionId: string,
  result: { stdout: string; status: number | null }
): string | undefined {
  if (result.status === 0) {
    try {
      const parsed = JSON.parse(result.stdout) as { requestId?: string; reason?: string };
      if (parsed.requestId && !parsed.reason) return parsed.requestId;
    } catch {
      // Non-JSON stdout — fall through to the approval-store lookup below.
    }
  }
  const correlationId = `mission-alignment-${missionId}`;
  const pending = listApprovalRequests({ status: 'pending', kind: 'mission_gate' }).find(
    (item) => item.correlationId === correlationId
  );
  return pending?.id;
}

function decidedByToHearingMissionMember(decidedBy: HearingDecidedBy): HearingMissionMember {
  return {
    id: decidedBy.id,
    ...(decidedBy.display_name ? { display_name: decidedBy.display_name } : {}),
    ...(decidedBy.role ? { role: decidedBy.role } : {}),
  };
}

/** Child scope is explicit; the role/delegation remains the existing governed one. */
function missionChildEnv(scope: HearingHandoffDestination, controller: boolean): NodeJS.ProcessEnv {
  const env = controller
    ? buildExecutionEnv(process.env, 'mission_controller')
    : { ...process.env };
  env.KYBERION_TENANT = scope.tenantSlug;
  if (scope.organizationId) env.KYBERION_ORGANIZATION_ID = scope.organizationId;
  else delete env.KYBERION_ORGANIZATION_ID;
  if (scope.projectId) env.KYBERION_PROJECT_ID = scope.projectId;
  else delete env.KYBERION_PROJECT_ID;
  return env;
}

/** A successful child exit never proves that it created the intended destination. */
function missionMatchesHandoff(
  state: MissionState | null,
  missionId: string,
  scope: HearingHandoffDestination,
  ctx: HearingRouteContext
): boolean {
  if (
    !state ||
    state.mission_id !== missionId ||
    state.status !== 'planned' ||
    state.tier !== 'confidential' ||
    state.tenant_slug !== scope.tenantSlug
  )
    return false;
  const flat = state as MissionState & { project_id?: string };
  const relationshipOrg = state.relationships?.organization?.organization_id;
  const relationshipProject = state.relationships?.project?.project_id;
  if (state.organization_id && relationshipOrg && state.organization_id !== relationshipOrg)
    return false;
  if (flat.project_id && relationshipProject && flat.project_id !== relationshipProject)
    return false;
  const organizationId = state.organization_id ?? relationshipOrg;
  const projectId = relationshipProject ?? flat.project_id;
  if (organizationId !== scope.organizationId || projectId !== scope.projectId) return false;
  const projection = {
    ...state,
    ...(organizationId ? { organization_id: organizationId } : {}),
    ...(projectId ? { project_id: projectId } : {}),
  };
  const canonical = eventScopeFromRecord(projection);
  return Boolean(
    canonical &&
    canonical.mission_id === missionId &&
    canonical.tier === 'confidential' &&
    canonical.tenant_slug === scope.tenantSlug &&
    canonical.organization_id === scope.organizationId &&
    canonical.project_id === scope.projectId &&
    ctx.recordInScope(projection)
  );
}

/**
 * HT-03 (2nd half): confirm-and-hand-off. Owner only (a held-action mutation,
 * same posture as `/decide`); member resolution mirrors `/decide` exactly —
 * an unregistered principal is refused (403) rather than silently attributed.
 * The mission's `decided_by` is `record.decided_by`, the human who decided on
 * the hearing card (FD-10 principle 4). A failure after the effect was
 * reserved is reported as `handoff_unresolved`.
 * `POST /api/hearing/:session/handoff`.
 */
export function handOffHearingToMission(
  ctx: HearingRouteContext,
  rawSessionId: unknown,
  rawBody: unknown,
  query: HearingQuery
): HearingRouteResult {
  let effectReserved = false;
  try {
    const sessionId = hearingMissionSessionId(rawSessionId);
    const storage = ctx.storage();
    const namespace = storage.namespace;
    const locale = hearingQueryLocale(query);

    const record = storage.load(sessionId) as HearingRecordWithMissionHandoff | null;
    assertHearingLedgerServed(ctx.ledger, record?.scenario);
    if (!record) {
      throw new HearingMissionRequestError(409, 'Hearing record does not exist yet.');
    }

    // WI-08: a scenario registered with `handoff: 'work_inventory'` never
    // becomes a mission — it confirms into a work-inventory entry via
    // `POST /api/hearing/:session/inventory` instead. An unregistered/legacy
    // scenario id (no catalog entry) is still handed off as a mission.
    const scenarioDef = findHearingScenario(record.scenario);
    if (scenarioDef?.handoff === 'work_inventory') {
      throw new HearingMissionRequestError(
        400,
        'This hearing scenario is not handed off as a mission.'
      );
    }

    const member = resolveHearingMember(ctx.viewer);
    if (!member) {
      throw ctx.denied(403, 'mission handoff is recorded for registered members only');
    }

    // Idempotent: a session already handed off returns the same ids
    // instead of minting a second mission or a second approval request.
    assertHearingHandoffReplay(record, 'mission');
    assertHearingHandoffSnapshot(
      parseHearingRequestBody(rawBody, 'hearing handoff'),
      record,
      ctx.viewer,
      { currentSurface: ctx.currentSurface, owner: ctx.owner }
    );
    if (record.mission_id && record.approval_request_id) {
      return {
        kind: 'json',
        status: 200,
        body: {
          ok: true,
          mission_id: record.mission_id,
          approval_request_id: record.approval_request_id,
          next_action: buildDecideNextAction(locale, ctx),
        },
      };
    }

    assertHearingEditable(record);

    if (!record.decided_by || !record.decided_at) {
      throw new HearingMissionRequestError(
        409,
        'Hearing record must be decided (POST .../decide) before handoff.'
      );
    }
    const scope = ctx.handoffScope('mission');
    const nextAction = buildDecideNextAction(locale, ctx);
    const decidedBy = decidedByToHearingMissionMember(record.decided_by);
    const brief: MissionBrief = hearingRecordToMissionBrief(record, {
      locale,
      tenantSlug: namespace,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      member: decidedBy,
    });
    const missionId = brief.missionId as string;

    const rootDir = pathResolver.rootDir();
    const controllerPath = pathResolver.rootResolve(CONTROLLER_RELATIVE);
    assertGovernedScriptBuilt(controllerPath, 'mission controller');
    const alignmentPath = pathResolver.rootResolve(ALIGNMENT_REQUEST_RELATIVE);
    assertGovernedScriptBuilt(alignmentPath, 'mission alignment request');

    const createArgs = buildHearingMissionCreateArgs({
      missionId,
      brief,
      tenantSlug: namespace,
      tier: 'confidential',
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      decidedBy,
    });
    const reserved = storage.reserve(record, 'mission', nowIso());
    effectReserved = true;
    const createResult = safeExecResult(process.execPath, [CONTROLLER_RELATIVE, ...createArgs], {
      env: missionChildEnv(scope, true),
      cwd: rootDir,
      timeoutMs: 60_000,
      maxOutputMB: 5,
    });
    ctx.audit('info', 'hearing.handoff.create', {
      mission_id: missionId,
      exit: createResult.status,
    });

    // Exit code 0 alone is not success — verify the mission actually
    // landed on disk in `planned` status before trusting the CLI's exit code.
    const { missionDir, state } = withExecutionContext(
      'ecosystem_architect',
      () => {
        const missionDir = findMissionPath(missionId);
        return { missionDir, state: missionDir ? loadState(missionId) : null };
      },
      undefined,
      namespace,
      scope.organizationId
    );
    if (
      createResult.status !== 0 ||
      !missionDir ||
      !missionMatchesHandoff(state, missionId, scope, ctx)
    ) {
      throw new HearingMissionRequestError(502, `Mission ${missionId} was not created.`);
    }

    // Writing into a mission's `evidence/` directory is a governed mission
    // write, not a plain surface-runtime one — the policy engine refuses
    // persona 'worker' / role `surface_runtime` here (same authority
    // boundary `mission_controller.js create` itself runs under, via
    // `buildExecutionEnv(process.env, 'mission_controller')` on the subprocess
    // above — delegated under SYSTEM_ROLE, AUTHORITY_MODEL 3.B2 DR-01). Elevate
    // only for this write.
    withExecutionContext(
      'mission_controller',
      () => {
        const evidenceDir = assertSafeRepositoryPath(`${missionDir}/evidence`, {
          allowMissingLeaf: true,
        });
        if (!safeExistsSync(evidenceDir)) safeMkdir(evidenceDir, { recursive: true });
        const briefPath = assertSafeRepositoryPath(`${missionDir}/evidence/mission-brief.json`, {
          allowMissingLeaf: true,
        });
        safeWriteFile(briefPath, `${JSON.stringify(brief, null, 2)}\n`, { encoding: 'utf8' });
      },
      undefined,
      namespace,
      scope.organizationId
    );

    const alignmentResult = safeExecResult(
      process.execPath,
      [ALIGNMENT_REQUEST_RELATIVE, '--mission', missionId, '--json'],
      { env: missionChildEnv(scope, false), cwd: rootDir, timeoutMs: 30_000, maxOutputMB: 5 }
    );
    const approvalRequestId = resolveAlignmentRequestId(missionId, alignmentResult);
    if (!approvalRequestId) {
      throw new HearingMissionRequestError(
        502,
        `Alignment approval for ${missionId} was not opened.`
      );
    }

    const patch: Partial<HearingRecordWithMissionHandoff> = {
      mission_id: missionId,
      approval_request_id: approvalRequestId,
      handed_off_at: nowIso(),
    };
    storage.finish(reserved, patch);

    return {
      kind: 'json',
      status: 200,
      body: {
        ok: true,
        mission_id: missionId,
        approval_request_id: approvalRequestId,
        next_action: nextAction,
      },
    };
  } catch (error) {
    if (effectReserved) {
      ctx.audit('warn', 'hearing.handoff.unresolved', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new HearingConflictError('handoff_unresolved');
    }
    throw error;
  }
}
