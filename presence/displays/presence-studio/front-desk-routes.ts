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
import { normalizeLocale } from '@agent/core/foundation/locale-normalize';
import { readFrontDeskMe } from '@agent/core/front-desk-identity';
import {
  memberBindingDenied,
  resolveMemberByPrincipal,
} from '@agent/core/organization/member-registry';
import {
  FRONT_DESK_HELP_LINK,
  readAvailableFrontDeskSurfaces,
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
import { listArtifactRecords } from '@agent/core/workforce/artifact-record';
import { listInboxEntries } from '@agent/core/deliverable-inbox';
import { readSurfaceStringParam } from '@agent/core/surface/surface-request-input';
import { listTaskSessions } from '@agent/core/task/task-session';
import { pathResolver } from '@agent/core/path-resolver';
import {
  PresenceStudioViewerError,
  parsePresenceStudioAgentIdentity,
  parsePresenceStudioSovereignIdentity,
  narrowPresenceStudioScope,
  presenceStudioRecordInScope,
  resolvePresenceStudioViewerContext,
  summarizePresenceStudioIdentity,
  toFrontDeskViewerScope,
  type PresenceStudioViewerContext,
} from './security.js';
import { presenceAvailableOperations } from './headless.js';
import {
  buildProgressPayload,
  deriveProgressArtifactTitle,
  findMatchingInboxEntry,
  progressTaskSessionInput,
  resolveComputerSurfaceMirrorHref,
  type ProgressArtifactInput,
} from '@agent/core/surface/front-desk-progress';

import { ASK_VOCABULARY_KEYS, HOME_VOCABULARY_KEYS } from './front-desk-pages.js';
import * as presenceStudioData from './presence-studio-runtime-data.js';

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

export function registerFrontDeskRoutes(app: express.Express): void {
  // FD-01: unified `GET /api/me` — see FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md
  // §2.4. Tenant profiles live under the personal tier, so the read runs
  // inside the same `ecosystem_architect` execution context `/api/identity`
  // already uses for this surface (concierge's equivalent uses
  // `sovereign_concierge`; presence-studio keeps its own established persona).
  app.get('/api/me', (req, res) => {
    try {
      const viewer = resolvePresenceStudioViewerContext(req);
      // FD-01: the loopback owner's tenant list is their memberships (all
      // tenants), with the request's effective tenant as the one being viewed.
      const scope = toFrontDeskViewerScope(
        viewer.source === 'loopback' ? { ...viewer, tenantSlugs: 'all' } : viewer
      );
      const requestedTenant =
        readSurfaceStringParam(req.query.tenant) ??
        (viewer.tenantSlugs !== 'all' ? viewer.tenantSlugs[0] : undefined);
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
  // is the shared existing-feature catalog).
  app.get('/api/front-desk/nav', async (req, res) => {
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
        availableSurfaces: await readAvailableFrontDeskSurfaces(),
        ports: readFrontDeskSurfacePorts(),
        urls: readFrontDeskSurfaceUrls(),
        role,
      }).map((item) => ({
        id: item.id,
        group_label: item.group_key
          ? catalogT(item.group_key as VocabularyKey, undefined, locale)
          : '',
        icon: item.icon,
        scope_query_style: item.scope_query_style,
        label: catalogT(item.label_key as VocabularyKey, undefined, locale),
        sublabel: catalogT(item.sublabel_key as VocabularyKey, undefined, locale),
        href: item.href,
        external: item.external,
        allowed: item.allowed,
        min_role: item.min_role,
        placement: item.placement ?? 'main',
      }));
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        locale,
        current_surface: 'presence-studio' as const,
        items,
        help: {
          label: catalogT(FRONT_DESK_HELP_LINK.label_key as VocabularyKey, undefined, locale),
          // 使い方 is served by Concierge (Kyberion server phase 2).
          href:
            readFrontDeskSurfaceUrls()[FRONT_DESK_HELP_LINK.surface] + FRONT_DESK_HELP_LINK.path,
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

  // FD-05: the requests read model. The 進み具合 page itself moved to
  // Concierge (仕事 › 依頼, `/work?tab=requests`); this route stays for the
  // 頼む page's recent-requests list (`static/ask-read-recovery.js`). Pure
  // assembly is shared with Concierge (`@agent/core/surface/front-desk-progress`);
  // viewer-scoped the same way `/api/home` is (`?tenant=` narrows, never
  // widens).
  app.get('/api/progress', (req, res) => {
    try {
      const viewer = resolvePresenceStudioViewerContext(req);
      const requestedTenant = readSurfaceStringParam(req.query.tenant);
      const scopedViewer = narrowPresenceStudioScope(viewer, {
        tenant: requestedTenant,
        organizationId: readSurfaceStringParam(req.query.organizationId),
        projectId: readSurfaceStringParam(req.query.projectId),
      });

      const taskSessions = listTaskSessions('presence')
        .filter((session) => presenceStudioRecordInScope(scopedViewer, session))
        .map(progressTaskSessionInput);

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
            title: deriveProgressArtifactTitle(record),
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

  // FD-03: exactly the keys `static/ask.js` renders. Mirrors
  // `/api/home-vocabulary` above.
  app.get('/api/ask-vocabulary', (req, res) => {
    const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
    const texts = Object.fromEntries(
      ASK_VOCABULARY_KEYS.map((key) => [key, catalogT(key, undefined, locale)])
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, locale, texts });
  });

  registerConversationRoutes(app);
}
