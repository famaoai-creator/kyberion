// Front-desk API routes, split out of `server.ts` purely to keep that file
// under the repo's `max-file-lines` gate (knowledge/product/governance/
// max-file-lines.json) — no behavior change. `registerFrontDeskRoutes` is
// called once from `server.ts` at the same position these routes were
// registered before this split, so the `/api` + `/a2ui` guard and rate
// limiter (`presence-studio-runtime-data.ts`) still run ahead of every route
// here exactly as they did when these were inline in `server.ts`.
import type express from 'express';
import * as path from 'node:path';
import { registerConversationRoutes } from './conversation-routes.js';
import { readWorkHome } from './work-home-source.js';
import {
  conversationRef,
  presenceFrontDeskConversationViewer,
} from '@agent/core/surface/front-desk-conversation-store';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';
import { normalizeLocale } from '@agent/core/locale-normalize';
import { readFrontDeskMe } from '@agent/core/front-desk-identity';
import {
  memberBindingDenied,
  resolveMemberByPrincipal,
} from '@agent/core/organization/member-registry';
import {
  FRONT_DESK_HELP_LINK,
  frontDeskRoleFromViewer,
  readFrontDeskSurfacePorts,
  readFrontDeskSurfaceUrls,
  resolveFrontDeskMenu,
  type FrontDeskRole,
} from '@agent/core/front-desk-nav';
import {
  loadPersonalAgentIdentityAtPath,
  loadPersonalIdentityAtPath,
} from '@agent/core/personal-identity-reader';
import { withExecutionContext } from '@agent/core/authority';
import { logger } from '@agent/core/core';
import { listArtifactRecords } from '@agent/core/workforce/artifact-record';
import {
  acceptInboxEntryWithHumanReceipt,
  listInboxEntries,
  markInboxEntry,
} from '@agent/core/deliverable-inbox';
import { readSurfaceStringParam } from '@agent/core/surface/surface-request-input';
import { listTaskSessions } from '@agent/core/task/task-session';
import { pathResolver } from '@agent/core/path-resolver';
import {
  PresenceStudioViewerError,
  parsePresenceStudioAgentIdentity,
  parsePresenceStudioSovereignIdentity,
  narrowPresenceStudioScope,
  presenceStudioOutcomeVerdictSchema,
  presenceStudioRecordInScope,
  resolvePresenceStudioViewerContext,
  requirePresenceStudioLocalAdmin,
  readPresenceStudioStringParam,
  summarizePresenceStudioIdentity,
  toFrontDeskViewerScope,
  type PresenceStudioViewerContext,
} from './security.js';
import { presenceAvailableOperations } from './headless.js';
import {
  buildProgressDetail,
  buildProgressPayload,
  resolveComputerSurfaceMirrorHref,
  type ProgressArtifactInput,
  type ProgressHistoryEntryInput,
  type ProgressTaskSessionInput,
} from './progress.js';

import {
  ASK_VOCABULARY_KEYS,
  HELP_VOCABULARY_KEYS,
  HOME_VOCABULARY_KEYS,
  PROGRESS_VOCABULARY_KEYS,
} from './front-desk-pages.js';
import * as presenceStudioData from './presence-studio-runtime-data.js';

/** Same "never dump raw markdown as a title" heuristic the /work outcome
 * panel's client-side `outcomeTitle()` uses (static/index.html) — reused
 * here so `GET /api/home` and the existing outcome inbox agree. */
function deriveHomeArtifactTitle(record: {
  path?: string;
  preview_text?: string;
  kind: string;
}): string {
  const fromPath = record.path ? String(record.path).split('/').filter(Boolean).pop() : '';
  if (fromPath) return fromPath;
  const firstLine = String(record.preview_text || '')
    .split('\n')[0]
    .replace(/^#+\s*/, '')
    .trim();
  return firstLine.length > 3 && firstLine.length <= 60 ? firstLine : record.kind || 'outcome';
}

/** Same onboarded determination as `/api/identity` (server.ts), reused by
 * `/api/me` (FD-01). */
function resolvePresenceStudioOnboarded(): boolean {
  const personalDir = pathResolver.knowledge('personal');
  const idPath = path.join(personalDir, 'my-identity.json');
  const agentPath = path.join(personalDir, 'agent-identity.json');
  return withExecutionContext('ecosystem_architect', () => {
    const safeIdPath = presenceStudioData.resolveSafeExistingFile(idPath);
    const safeAgentPath = presenceStudioData.resolveSafeExistingFile(agentPath);
    const sovereign = safeIdPath
      ? parsePresenceStudioSovereignIdentity(loadPersonalIdentityAtPath(safeIdPath))
      : null;
    const agent = safeAgentPath
      ? parsePresenceStudioAgentIdentity(loadPersonalAgentIdentityAtPath(safeAgentPath))
      : null;
    return summarizePresenceStudioIdentity({ sovereign, agent, vision: null }).onboarded;
  });
}

function progressHistoryFromTaskSession(session: {
  history?: Array<{ ts?: string; text?: string }>;
}): ProgressHistoryEntryInput[] {
  return Array.isArray(session.history)
    ? session.history
        .filter((entry): entry is { ts?: string; text: string } => Boolean(entry?.text))
        .map((entry) => ({ when: entry.ts, text: entry.text }))
    : [];
}

/** Best-effort link from an artifact record to the deliverable-inbox entry
 * that (maybe) carries it — see `progress.ts`'s module doc: these are two
 * different stores with two different id spaces, and the only thing that
 * can connect a given record to an entry is a shared `path` on both sides.
 * No match means this artifact can never be verdict-eligible here. */
function findMatchingInboxEntry(
  inboxEntries: ReturnType<typeof listInboxEntries>,
  artifactPath: string | undefined
) {
  if (!artifactPath) return undefined;
  return inboxEntries.find((entry) => entry.artifact_paths.includes(artifactPath));
}

/** Membership-aware rail role (B1): a resolved member's viewed-tenant
 * membership role gates nav items; a member with no membership on that
 * tenant is a viewer, and an unresolved principal keeps the flat
 * viewer-scope mapping. */
function resolvePresenceStudioNavRole(viewer: PresenceStudioViewerContext): FrontDeskRole {
  const input = {
    principalId: viewer.principalId,
    source: viewer.source,
    registrationLabel: viewer.principal?.registrationLabel,
    memberId: viewer.principal?.memberId,
  };
  let member = null;
  let bindingDenied = false;
  try {
    member = withExecutionContext('ecosystem_architect', () => resolveMemberByPrincipal(input));
    bindingDenied =
      !member && withExecutionContext('ecosystem_architect', () => memberBindingDenied(input));
  } catch {
    member = null;
    // Unreadable registry: an asserted binding (memberId or label) cannot
    // be disproven — fail closed.
    bindingDenied = Boolean(viewer.principal?.memberId || viewer.principal?.registrationLabel);
  }
  if (bindingDenied) return 'viewer';
  if (member) {
    const tenant = viewer.tenantSlugs !== 'all' ? viewer.tenantSlugs[0] : undefined;
    if (tenant) {
      return member.memberships.find((item) => item.tenant_slug === tenant)?.role ?? 'viewer';
    }
  }
  return frontDeskRoleFromViewer({ role: toFrontDeskViewerScope(viewer).role });
}

/** FD-10/F4: the member actor behind a recorded decision on this surface.
 * Loopback resolves to the provisioned owner member, a member-bound token
 * to its own member — attribution is always `user:<member_id>` once a
 * member resolves. An asserted member binding that fails to resolve is a
 * hard 403 (never the synthetic principal id), and the membership on the
 * tenant the decision lands on must be owner/approver. Only a genuinely
 * unregistered principal keeps the legacy `principalId` attribution. */
function resolvePresenceStudioDecisionActor(
  viewer: PresenceStudioViewerContext,
  resourceTenant?: string
): { actorId: string; role?: 'owner' | 'approver' } {
  const input = {
    principalId: viewer.principalId,
    source: viewer.source,
    registrationLabel: viewer.principal?.registrationLabel,
    memberId: viewer.principal?.memberId,
  };
  let member = null;
  let bindingDenied = Boolean(viewer.principal?.memberId);
  try {
    member = withExecutionContext('ecosystem_architect', () => resolveMemberByPrincipal(input));
    if (!member) {
      // A label-bound token matching a suspended member's
      // access_registrations is denied too — "unregistered" would be an
      // upgrade for a localadmin-class credential.
      bindingDenied =
        bindingDenied ||
        withExecutionContext('ecosystem_architect', () => memberBindingDenied(input));
    }
  } catch {
    member = null;
    // Unreadable registry: an asserted binding cannot be disproven.
    bindingDenied = bindingDenied || Boolean(viewer.principal?.registrationLabel);
  }
  if (!member) {
    if (bindingDenied) {
      throw new PresenceStudioViewerError(403, 'member binding could not be verified');
    }
    return { actorId: viewer.principalId };
  }
  const isDecisionCapable = (role?: string) => role === 'owner' || role === 'approver';
  if (resourceTenant) {
    const role = member.memberships.find((item) => item.tenant_slug === resourceTenant)?.role;
    if (!isDecisionCapable(role)) {
      throw new PresenceStudioViewerError(403, 'this member role cannot record decisions');
    }
    return { actorId: `user:${member.member_id}`, role: role as 'owner' | 'approver' };
  }
  if (
    member.memberships.length === 0 ||
    member.memberships.some((item) => !isDecisionCapable(item.role))
  ) {
    throw new PresenceStudioViewerError(403, 'this member role cannot record decisions');
  }
  const roles = new Set(member.memberships.map((item) => item.role));
  return {
    actorId: `user:${member.member_id}`,
    role: roles.size === 1 ? (member.memberships[0].role as 'owner' | 'approver') : 'approver',
  };
}

export function registerFrontDeskRoutes(app: express.Express): void {
  // FD-01: unified `GET /api/me` — see FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md
  // §2.4. Tenant profiles live under the personal tier, so the read runs
  // inside the same `ecosystem_architect` execution context `/api/identity`
  // already uses for this surface (concierge's equivalent uses
  // `sovereign_concierge`; presence-studio keeps its own established persona).
  app.get('/api/me', (req, res) => {
    try {
      const viewer = resolvePresenceStudioViewerContext(req);
      const scope = toFrontDeskViewerScope(viewer);
      const requestedTenant = readSurfaceStringParam(req.query.tenant);
      const me = withExecutionContext('ecosystem_architect', () =>
        readFrontDeskMe(scope, {
          requestedTenant,
          availableOperations: presenceAvailableOperations(viewer),
          onboarded: resolvePresenceStudioOnboarded(),
        })
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(me);
    } catch (error) {
      const status = error instanceof PresenceStudioViewerError ? error.status : 500;
      res.status(status).json(presenceStudioData.presenceStudioWireError(error, status));
    }
  });

  // FD-00 / FD-01: the shared front-desk rail reads its menu + labels from
  // here so presence-studio and concierge never drift (libs/core/front-desk-nav.ts
  // is the single source of the 5-item menu).
  app.get('/api/front-desk/nav', (req, res) => {
    try {
      const resolved = resolvePresenceStudioViewerContext(req);
      const requestedTenant = readSurfaceStringParam(req.query.tenant) || undefined;
      const viewer = narrowPresenceStudioScope(resolved, {
        tenant: requestedTenant,
        organizationId: readSurfaceStringParam(req.query.organizationId),
        projectId: readSurfaceStringParam(req.query.projectId),
      });
      const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
      const role = resolvePresenceStudioNavRole(viewer);
      const items = resolveFrontDeskMenu({
        currentSurface: 'presence-studio',
        ports: readFrontDeskSurfacePorts(),
        urls: readFrontDeskSurfaceUrls(),
        role,
      }).map((item) => ({
        id: item.id,
        label: catalogT(item.label_key as VocabularyKey, undefined, locale),
        sublabel: catalogT(item.sublabel_key as VocabularyKey, undefined, locale),
        href: item.href,
        external: item.external,
        allowed: item.allowed,
        min_role: item.min_role,
      }));
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        locale,
        current_surface: 'presence-studio' as const,
        items,
        help: {
          label: catalogT(FRONT_DESK_HELP_LINK.label_key as VocabularyKey, undefined, locale),
          href: FRONT_DESK_HELP_LINK.path,
        },
        brand_tagline: catalogT('front_desk:brand_tagline', undefined, locale),
        aria_label: catalogT('front_desk:nav_aria_label', undefined, locale),
        tenant_switch_aria: catalogT('front_desk:tenant_switch_aria', undefined, locale),
        role_labels: {
          owner: catalogT('front_desk:role_owner', undefined, locale),
          approver: catalogT('front_desk:role_approver', undefined, locale),
          operator: catalogT('front_desk:role_operator', undefined, locale),
          viewer: catalogT('front_desk:role_viewer', undefined, locale),
        },
        tenant_viewing_summary: catalogT('front_desk:tenant_viewing_summary', undefined, locale),
        tenant_viewing_single: catalogT('front_desk:tenant_viewing_single', undefined, locale),
      });
    } catch (error) {
      const status = error instanceof PresenceStudioViewerError ? error.status : 500;
      res.status(status).json(presenceStudioData.presenceStudioWireError(error, status));
    }
  });

  // FD-02: exactly the `front_desk` keys static/home.js renders — mirrors
  // `/api/ui-vocabulary` (server.ts; raw, un-substituted templates; the
  // client does its own `{placeholder}` interpolation).
  app.get('/api/home-vocabulary', (req, res) => {
    const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
    const texts = Object.fromEntries(
      HOME_VOCABULARY_KEYS.map((key) => [key, catalogT(key, undefined, locale)])
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, locale, texts });
  });

  // FD-02: the presence-studio home page's single read model. Pure assembly
  // lives in `home.ts` (`buildHomePayload`) — this route only gathers the
  // same server-side data the existing approval inbox / OS control-plane /
  // requested-work / outcome-inbox panels already read, viewer-scoped the
  // same way (`?tenant=` narrows, never widens). See
  // FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md §2.1 / FD-02.
  app.get('/api/home', (req, res) => {
    try {
      const payload = readWorkHome(req);
      res.setHeader('Cache-Control', 'no-store');
      res.json(payload);
    } catch (error) {
      const status = error instanceof PresenceStudioViewerError ? error.status : 500;
      res.status(status).json(presenceStudioData.presenceStudioWireError(error, status));
    }
  });

  // FD-05: exactly the `front_desk` keys `static/progress.js` renders.
  // Mirrors `/api/home-vocabulary` above.
  app.get('/api/progress-vocabulary', (req, res) => {
    const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
    const texts = Object.fromEntries(
      PROGRESS_VOCABULARY_KEYS.map((key) => [key, catalogT(key, undefined, locale)])
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, locale, texts });
  });

  // FD-05: the presence-studio progress page's single read model ("進み具合").
  // Pure assembly lives in `progress.ts` (`buildProgressPayload`) — this
  // route only gathers the same server-side data the existing
  // requested-work / async / outcome-inbox panels already read,
  // viewer-scoped the same way `/api/home` is (`?tenant=` narrows, never
  // widens). See FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md §2.1 / FD-05.
  app.get('/api/progress', (req, res) => {
    try {
      const viewer = resolvePresenceStudioViewerContext(req);
      const requestedTenant = readSurfaceStringParam(req.query.tenant);
      const scopedViewer = narrowPresenceStudioScope(viewer, {
        tenant: requestedTenant,
        organizationId: readSurfaceStringParam(req.query.organizationId),
        projectId: readSurfaceStringParam(req.query.projectId),
      });

      const taskSessions: ProgressTaskSessionInput[] = listTaskSessions('presence')
        .filter((session) => presenceStudioRecordInScope(scopedViewer, session))
        .map((session) => ({
          id: session.session_id,
          correlation_id: session.correlation_id,
          title: session.goal?.summary || session.session_id,
          status: session.status,
          when: session.updated_at,
          history: progressHistoryFromTaskSession(session),
        }));

      const inboxEntries = listInboxEntries({ limit: 1000 }).filter((entry) =>
        presenceStudioRecordInScope(scopedViewer, entry)
      );
      const artifacts: ProgressArtifactInput[] = listArtifactRecords()
        .filter((record) => presenceStudioRecordInScope(scopedViewer, record))
        .map((record) => {
          const matchedEntry = findMatchingInboxEntry(inboxEntries, record.path);
          const downloadable =
            typeof record.path === 'string' &&
            presenceStudioData.isAllowedArtifactDownloadPath(record.path) &&
            presenceStudioData.resolveSafeExistingFile(record.path) !== null;
          return {
            id: record.artifact_id,
            title: deriveHomeArtifactTitle(record),
            kind: record.kind,
            when: matchedEntry?.updated_at || matchedEntry?.created_at,
            ...(matchedEntry
              ? { inbox_status: matchedEntry.status, entry_id: matchedEntry.entry_id }
              : {}),
            downloadable,
          };
        });

      const payload = buildProgressPayload({
        now: new Date(),
        taskSessions,
        artifacts,
        mirrorHref: resolveComputerSurfaceMirrorHref(),
      });
      res.setHeader('Cache-Control', 'no-store');
      const viewerScopeId = conversationRef(
        presenceFrontDeskConversationViewer(toFrontDeskViewerScope(scopedViewer))
      ).key;
      res.json({ ...payload, viewer_scope_id: viewerScopeId });
    } catch (error) {
      const status = error instanceof PresenceStudioViewerError ? error.status : 500;
      res.status(status).json(presenceStudioData.presenceStudioWireError(error, status));
    }
  });

  // FD-05: detail for a single progress item. `:id` is either a task-session
  // id (active/done rows) or an artifact-record id (delivered/done rows with
  // no backing task session) — see `progress.ts`'s module doc on why these
  // are two separate id spaces.
  app.get('/api/progress/:id', (req, res) => {
    const id = readPresenceStudioStringParam(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id is required' });
    try {
      const viewer = resolvePresenceStudioViewerContext(req);
      const requestedTenant = readSurfaceStringParam(req.query.tenant);
      const scopedViewer = narrowPresenceStudioScope(viewer, {
        tenant: requestedTenant,
        organizationId: readSurfaceStringParam(req.query.organizationId),
        projectId: readSurfaceStringParam(req.query.projectId),
      });

      const directSession = presenceStudioData.findTaskSession(id);
      const artifact = directSession
        ? undefined
        : listArtifactRecords().find((record) => record.artifact_id === id);
      if (artifact && !presenceStudioRecordInScope(scopedViewer, artifact))
        return res.status(404).json({ ok: false, error: `progress item not found: ${id}` });
      const session = directSession
        ? directSession
        : artifact?.task_session_id
          ? presenceStudioData.findTaskSession(artifact.task_session_id)
          : null;

      if (session) {
        if (!presenceStudioRecordInScope(scopedViewer, session)) {
          return res.status(404).json({ ok: false, error: `progress item not found: ${id}` });
        }
        const detail = buildProgressDetail(
          {
            goal_summary: session.goal?.summary || session.session_id,
            success_condition: session.goal?.success_condition,
            status: session.status,
            next_step: session.completion_next_action?.next_step,
            gaps: session.completion_next_action?.gaps,
          },
          progressHistoryFromTaskSession(session)
        );
        return res.json({ ok: true, item: detail });
      }

      if (artifact) {
        if (!presenceStudioRecordInScope(scopedViewer, artifact)) {
          return res.status(404).json({ ok: false, error: `progress item not found: ${id}` });
        }
        const matchedEntry = findMatchingInboxEntry(
          listInboxEntries({ limit: 1000 }).filter((entry) =>
            presenceStudioRecordInScope(scopedViewer, entry)
          ),
          artifact.path
        );
        const detail = buildProgressDetail(
          {
            goal_summary: deriveHomeArtifactTitle(artifact),
            status: matchedEntry?.status || artifact.kind,
          },
          []
        );
        return res.json({ ok: true, item: detail });
      }

      return res.status(404).json({ ok: false, error: `progress item not found: ${id}` });
    } catch (error) {
      const status = error instanceof PresenceStudioViewerError ? error.status : 500;
      res.status(status).json(presenceStudioData.presenceStudioWireError(error, status));
    }
  });

  // FD-05: 受け取る / 直してもらう — the only mutation on the progress page.
  // `:id` is a deliverable-inbox `entry_id` (never an artifact-record id —
  // see `progress.ts`'s module doc), and this always requires the
  // server-derived loopback localadmin session, matching every other
  // Presence Studio decision mutation
  // (`/api/os/held-actions/:actionId/decision`,
  // `/api/approvals/:requestId/decision`).
  app.post('/api/outcomes/:id/verdict', (req, res) => {
    const entryId = readPresenceStudioStringParam(req.params.id);
    const parsed = presenceStudioOutcomeVerdictSchema.safeParse(
      presenceStudioData.safeParsePresenceStudioRequestBody(req.body, 'outcome verdict body')
    );
    if (!entryId || !parsed.success) {
      return res.status(400).json({
        ok: false,
        error: 'id and status (accepted|rejected) are required',
      });
    }
    try {
      const viewer = resolvePresenceStudioViewerContext(req);
      requirePresenceStudioLocalAdmin(viewer);
      const requestedTenant = readSurfaceStringParam(req.query.tenant);
      const scopedViewer = narrowPresenceStudioScope(viewer, {
        tenant: requestedTenant,
        organizationId: readSurfaceStringParam(req.query.organizationId),
        projectId: readSurfaceStringParam(req.query.projectId),
      });
      const viewerScopeId = conversationRef(
        presenceFrontDeskConversationViewer(toFrontDeskViewerScope(scopedViewer))
      ).key;
      if (parsed.data.viewer_scope_id && parsed.data.viewer_scope_id !== viewerScopeId) {
        return res
          .status(409)
          .json({ ok: false, error: 'decision_scope_changed', retry_safe: true });
      }
      const { status, note } = parsed.data;
      // The verdict lands on the entry's tenant — the member's role is
      // checked against THAT tenant, never the first scope entry (F2/F4).
      const entry = withExecutionContext('ecosystem_architect', () =>
        listInboxEntries({}).find((item) => item.entry_id === entryId)
      );
      if (!entry) {
        return res.status(404).json({ ok: false, error: `deliverable not found: ${entryId}` });
      }
      if (!presenceStudioRecordInScope(scopedViewer, entry)) {
        return res
          .status(403)
          .json({ ok: false, error: 'deliverable_scope_denied', retry_safe: true });
      }
      const actor = resolvePresenceStudioDecisionActor(scopedViewer, entry.tenant_slug);
      const updated =
        status === 'accepted'
          ? acceptInboxEntryWithHumanReceipt({
              entryId,
              actorId: actor.actorId,
              authenticated: true,
              authMethod: 'surface_session',
              responsibilityStatement: 'I accept this deliverable on behalf of the operator.',
            })
          : markInboxEntry(entryId, 'rejected', {
              verdictNote: note,
              reviewedBy: actor.actorId,
            });
      if (!updated) {
        logger.warn(
          presenceStudioData.presenceStudioAuditLine(req, 'outcomes/verdict.reject', {
            entry_id: entryId,
            status: 404,
          })
        );
        return res.status(404).json({ ok: false, error: `deliverable not found: ${entryId}` });
      }
      logger.info(
        presenceStudioData.presenceStudioAuditLine(req, 'outcomes/verdict.complete', {
          entry_id: entryId,
          verdict: status,
          status: 200,
        })
      );
      return res.json({ ok: true, entry: updated });
    } catch (error) {
      const status = error instanceof PresenceStudioViewerError ? error.status : 500;
      logger.warn(
        presenceStudioData.presenceStudioAuditLine(req, 'outcomes/verdict.reject', {
          entry_id: entryId,
          status,
          error: error instanceof Error ? error.message : String(error),
        })
      );
      return res.status(status).json(presenceStudioData.presenceStudioWireError(error, status));
    }
  });

  // FD-03: exactly the keys `static/ask.js` renders. Mirrors
  // `/api/home-vocabulary` / `/api/progress-vocabulary` above.
  app.get('/api/ask-vocabulary', (req, res) => {
    const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
    const texts = Object.fromEntries(
      ASK_VOCABULARY_KEYS.map((key) => [key, catalogT(key, undefined, locale)])
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, locale, texts });
  });

  // HT-06: exactly the `front_desk` keys `static/help.js` renders for the
  // training block. Mirrors `/api/home-vocabulary` / `/api/progress-vocabulary`
  // / `/api/ask-vocabulary` above.
  app.get('/api/help-vocabulary', (req, res) => {
    const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
    const texts = Object.fromEntries(
      HELP_VOCABULARY_KEYS.map((key) => [key, catalogT(key, undefined, locale)])
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, locale, texts });
  });

  registerConversationRoutes(app);
}
