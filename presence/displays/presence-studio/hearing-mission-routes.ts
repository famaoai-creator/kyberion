// HT-03 (2nd half): hand a decided hearing record off to the governed
// mission/alignment pipeline. See
// docs/developer/improvement-plans-2026-08/FRONT_DESK_HEARING_TRAINING_PLAN_2026-09-14.ja.md
// §2.2 / HT-03 and FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md §2.5.
//
// This route NEVER imports `scripts/**` — mission state changes only ever
// go through `scripts/mission_controller.ts`, and the alignment gate only
// ever opens through `scripts/mission_alignment_request.ts` (AGENTS.md §1
// invariant). Both are invoked as built subprocesses via `safeExecResult`,
// exactly like `presence/displays/concierge/src/app/api/hygiene/[id]/route.ts`
// does for `start`/`cancel` — never as library imports. `hearing-mission.ts`
// (pure) builds the brief and the `create` argv; this file is the only place
// that touches disk or spawns a process.
//
// Registered right after `registerHearingRoutes` in `server.ts` (same guard
// position — behind the shared `/api`/`/a2ui` guard + rate limiter every
// other API route runs behind).
import type express from 'express';
import type { Request, Response } from 'express';
import { nowIso } from '@agent/core/foundation';
import { t as catalogT } from '@agent/core/t';
import { normalizeLocale, type SupportedLocale } from '@agent/core/locale-normalize';
import { readSurfaceStringParam } from '@agent/core/surface/surface-request-input';
import { buildExecutionEnv, withExecutionContext } from '@agent/core/authority';
import { logger } from '@agent/core/core';
import { resolveMemberByPrincipal } from '@agent/core/organization/member-registry';
import { resolveFrontDeskMenu, readFrontDeskSurfaceUrls } from '@agent/core/front-desk-nav';
import { frontDeskRoleFromViewerScope } from '@agent/core/front-desk-identity';
import type { MissionState } from '@agent/core/mission/mission-types';
import { eventScopeFromRecord } from '@agent/core/event-scope';
import { findHearingScenario } from '@agent/core/hearing-scenario-catalog';
import { pathResolver, findMissionPath } from '@agent/core/path-resolver';
import { loadState } from '@agent/core/mission/mission-state';
import {
  assertSafeRepositoryPath,
  safeExecResult,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from '@agent/core/secure-io';
import { listApprovalRequests } from '@agent/core/governance/approval-store';
import {
  PresenceStudioViewerError,
  requirePresenceStudioLocalAdmin,
  presenceStudioRecordInScope,
  toFrontDeskViewerScope,
  type PresenceStudioViewerContext,
} from './security.js';
import {
  assertHearingEditable,
  HearingConflictError,
  HearingOperationError,
  assertHearingHandoffReplay,
} from './hearing-runtime.js';
import { hearingStorageForViewer } from './hearing-storage-access.js';
import {
  HearingScopeError,
  resolveHearingRequestViewer,
  resolveHearingHandoffScope,
} from './hearing-request-scope.js';
import { assertHearingHandoffSnapshot } from './hearing-handoff-snapshot.js';
import type { HearingDecidedBy, HearingRecord } from './hearing.js';
import {
  buildHearingMissionCreateArgs,
  hearingRecordToMissionBrief,
  type HearingMissionMember,
  type MissionBrief,
} from './hearing-mission.js';
import * as presenceStudioData from './presence-studio-runtime-data.js';

const CONTROLLER_RELATIVE = 'dist/scripts/mission_controller.js';
const ALIGNMENT_REQUEST_RELATIVE = 'dist/scripts/mission_alignment_request.js';

/** Additive fields this route owns on the hearing record. `hearing.ts` (the
 * base `HearingRecord` contract, `decided_by`/`decided_at` included) is the
 * concurrent sibling's file — these three fields are only ever read/written
 * here, via an intersection type, never added to the base interface. */
export interface HearingMissionHandoffFields {
  mission_id?: string;
  approval_request_id?: string;
  handed_off_at?: string;
}

export type HearingRecordWithMissionHandoff = HearingRecord & HearingMissionHandoffFields;

class HearingMissionRequestError extends Error {
  constructor(
    public readonly status: 400 | 403 | 409 | 502 | 503,
    message: string
  ) {
    super(message);
  }
}

function hearingMissionSessionId(req: Request): string {
  const sessionId = String(req.params.session || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u.test(sessionId)) {
    throw new HearingMissionRequestError(400, 'Invalid hearing session id.');
  }
  return sessionId;
}

function hearingMissionResponseError(req: Request, res: Response, error: unknown): void {
  const status =
    error instanceof HearingConflictError
      ? 409
      : error instanceof HearingMissionRequestError ||
          error instanceof HearingOperationError ||
          error instanceof HearingScopeError
        ? error.status
        : error instanceof PresenceStudioViewerError
          ? error.status
          : 500;
  logger.warn(
    presenceStudioData.presenceStudioAuditLine(req, 'hearing.handoff.reject', {
      status,
      error: error instanceof Error ? error.message : String(error),
    })
  );
  res.status(status).json({
    ...presenceStudioData.presenceStudioWireError(error, status),
    ...(error instanceof HearingConflictError ? { hearing_conflict: error.conflict } : {}),
    ...(error instanceof HearingScopeError ? { hearing_scope_error: error.code } : {}),
  });
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

function buildDecideNextAction(locale: SupportedLocale, viewer: PresenceStudioViewerContext) {
  const scope = toFrontDeskViewerScope(viewer);
  const item = resolveFrontDeskMenu({
    currentSurface: 'presence-studio',
    urls: readFrontDeskSurfaceUrls(),
    role: frontDeskRoleFromViewerScope(scope),
  }).find((candidate) => candidate.id === 'decide');
  if (!item?.allowed) throw new HearingScopeError('hearing_scope_unavailable');
  const url = new URL(item.href);
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
  const href = url.href;
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

type HearingMissionScope = ReturnType<typeof resolveHearingHandoffScope>;

/** Child scope is explicit; the role/delegation remains the existing governed one. */
function missionChildEnv(scope: HearingMissionScope, controller: boolean): NodeJS.ProcessEnv {
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
  scope: HearingMissionScope,
  viewer: PresenceStudioViewerContext
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
    presenceStudioRecordInScope(viewer, projection)
  );
}

export function registerHearingMissionRoutes(app: express.Express): void {
  // HT-03 (2nd half): confirm-and-hand-off. Localadmin only (a held-action
  // mutation, same posture as `/decide`); member resolution mirrors
  // `/decide` exactly — an unregistered principal is refused (403) rather
  // than silently attributed. The mission's `decided_by` is not this
  // request's resolved member, though: it is `record.decided_by`, the human
  // who actually decided on the hearing card — the one and only human
  // decision this handoff carries forward (FD-10 principle 4).
  app.post('/api/hearing/:session/handoff', (req, res) => {
    let effectReserved = false;
    try {
      const viewer = resolveHearingRequestViewer(req);
      requirePresenceStudioLocalAdmin(viewer);
      const sessionId = hearingMissionSessionId(req);
      const storage = hearingStorageForViewer(viewer);
      const namespace = storage.namespace;
      const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';

      const record = storage.load(sessionId) as HearingRecordWithMissionHandoff | null;
      if (!record) {
        throw new HearingMissionRequestError(409, 'Hearing record does not exist yet.');
      }

      // WI-08: a scenario registered with `handoff: 'work_inventory'` in
      // `hearing-scenarios.json` (e.g. `work_inventory`) never becomes a
      // mission — it confirms into a work-inventory entry via
      // `POST /api/hearing/:session/inventory` in `hearing-routes.ts`
      // instead, which carries the matching refusal for `handoff: 'mission'`
      // scenarios. An unregistered/legacy scenario id (no catalog entry)
      // keeps today's behavior and is still handed off as a mission.
      const scenarioDef = findHearingScenario(record.scenario);
      if (scenarioDef?.handoff === 'work_inventory') {
        throw new HearingMissionRequestError(
          400,
          'This hearing scenario is not handed off as a mission.'
        );
      }

      const member = withExecutionContext('ecosystem_architect', () =>
        resolveMemberByPrincipal({
          principalId: viewer.principalId,
          source: viewer.source,
          registrationLabel: viewer.principal?.registrationLabel,
          memberId: viewer.principal?.memberId,
        })
      );
      if (!member) {
        throw new PresenceStudioViewerError(
          403,
          'mission handoff is recorded for registered members only'
        );
      }

      // Idempotent: a session already handed off returns the same ids
      // instead of minting a second mission or a second approval request.
      assertHearingHandoffReplay(record, 'mission');
      assertHearingHandoffSnapshot(
        presenceStudioData.safeParsePresenceStudioRequestBody(req.body, 'hearing handoff'),
        record,
        viewer
      );
      if (record.mission_id && record.approval_request_id) {
        res.status(200).json({
          ok: true,
          mission_id: record.mission_id,
          approval_request_id: record.approval_request_id,
          next_action: buildDecideNextAction(locale, viewer),
        });
        return;
      }

      assertHearingEditable(record);

      if (!record.decided_by || !record.decided_at) {
        throw new HearingMissionRequestError(
          409,
          'Hearing record must be decided (POST .../decide) before handoff.'
        );
      }
      const scope = resolveHearingHandoffScope(viewer, 'mission');
      const nextAction = buildDecideNextAction(locale, viewer);
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
      logger.info(
        presenceStudioData.presenceStudioAuditLine(req, 'hearing.handoff.create', {
          mission_id: missionId,
          exit: createResult.status,
        })
      );

      // Exit code 0 alone is not success — verify the mission actually
      // landed on disk in `planned` status before trusting the CLI's exit
      // code (mirrors the concierge hygiene route's same verification).
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
        !missionMatchesHandoff(state, missionId, scope, viewer)
      ) {
        throw new HearingMissionRequestError(502, `Mission ${missionId} was not created.`);
      }

      // Writing into a mission's `evidence/` directory is a governed mission
      // write, not a plain surface-runtime one — the policy engine refuses
      // persona 'worker' / role `surface_runtime` here (same authority
      // boundary `mission_controller.js create` itself runs under, via
      // `buildExecutionEnv(process.env, 'mission_controller')` on the subprocess
      // above — delegated under SYSTEM_ROLE, AUTHORITY_MODEL 3.B2 DR-01). Elevate
      // only for this write, the same pattern `mission-coordination-bus.ts` /
      // `mission-task-recovery.ts` use for direct mission-directory writes.
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

      res.status(200).json({
        ok: true,
        mission_id: missionId,
        approval_request_id: approvalRequestId,
        next_action: nextAction,
      });
    } catch (error) {
      if (effectReserved) {
        logger.warn(
          presenceStudioData.presenceStudioAuditLine(req, 'hearing.handoff.unresolved', {
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
      hearingMissionResponseError(
        req,
        res,
        effectReserved ? new HearingConflictError('handoff_unresolved') : error
      );
    }
  });
}
