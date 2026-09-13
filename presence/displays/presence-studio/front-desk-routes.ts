// Front-desk API routes, split out of `server.ts` purely to keep that file
// under the repo's `max-file-lines` gate (knowledge/product/governance/
// max-file-lines.json) — no behavior change. `registerFrontDeskRoutes` is
// called once from `server.ts` at the same position these routes were
// registered before this split, so the `/api` + `/a2ui` guard and rate
// limiter (`presence-studio-runtime-data.ts`) still run ahead of every route
// here exactly as they did when these were inline in `server.ts`.
import type express from 'express';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseSafeJsonObjectValue } from '@agent/core/foundation';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';
import { normalizeLocale } from '@agent/core/locale-normalize';
import { readFrontDeskMe } from '@agent/core/front-desk-identity';
import {
  FRONT_DESK_HELP_LINK,
  frontDeskRoleFromViewer,
  readFrontDeskSurfacePorts,
  resolveFrontDeskMenu,
} from '@agent/core/front-desk-nav';
import {
  loadPersonalAgentIdentityAtPath,
  loadPersonalIdentityAtPath,
} from '@agent/core/personal-identity-reader';
import { withExecutionContext } from '@agent/core/authority';
import { logger } from '@agent/core/core';
import {
  applyBrowserOnboarding,
  getBrowserOnboardingState,
  previewBrowserOnboarding,
} from '@agent/core/browser-onboarding';
import { listApprovalRequests } from '@agent/core/approval-store';
import { listArtifactRecords } from '@agent/core/artifact-record';
import {
  acceptInboxEntryWithHumanReceipt,
  listInboxEntries,
  markInboxEntry,
} from '@agent/core/deliverable-inbox';
import { loadStandardIntentCatalog } from '@agent/core/intent-resolution';
import { readSurfaceStringParam } from '@agent/core/surface-request-input';
import { listTaskSessions } from '@agent/core/task-session';
import { pathResolver } from '@agent/core/path-resolver';
import { probeMicCapture } from '@agent/core/mic-capture';
import { isSimpleGreetingText } from '@agent/core/intent-contract';
import type { IntentResolutionContract } from '@agent/core/intent-resolution-contract-parser';
import { checkAndRepairSurfaceUxContract } from '@agent/core/surface-ux-contract';
import { runSurfaceMessageConversation } from '@agent/core/channel-surface';
import {
  PresenceStudioViewerError,
  presenceStudioConversationSchema,
  presenceStudioConversationScope,
  parsePresenceStudioAgentIdentity,
  parsePresenceStudioSovereignIdentity,
  narrowPresenceStudioTenant,
  presenceStudioOutcomeVerdictSchema,
  presenceStudioRecordInScope,
  resolvePresenceStudioViewerContext,
  requirePresenceStudioLocalAdmin,
  readPresenceStudioStringParam,
  summarizePresenceStudioIdentity,
  toFrontDeskViewerScope,
} from './security.js';
import { presenceAvailableOperations } from './headless.js';
import {
  buildHomePayload,
  type HomeArtifactInput,
  type HomeDecideCandidateInput,
  type HomeTaskSessionInput,
} from './home.js';
import {
  buildProgressDetail,
  buildProgressPayload,
  resolveComputerSurfaceMirrorHref,
  type ProgressArtifactInput,
  type ProgressHistoryEntryInput,
  type ProgressTaskSessionInput,
} from './progress.js';
import {
  parseAskVoiceHubReply,
  resolveIntentLabel,
  viewFromIntentResolution,
  type AskConversationView,
} from './ask-view.js';
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

// FD-03: `POST /api/conversation` — the "頼む" (ask) conversation turn.
// Node port of the concierge's `/api/message` route
// (`presence/displays/concierge/src/app/api/message/route.ts`): try
// voice-hub first (bounded by a short abort timeout so the UI never hangs on
// a stopped daemon), degrade to the in-process orchestrator, and only return
// `mode: 'unavailable'` when both paths genuinely fail — never a fabricated
// reply. Asking is a write (it can trigger delegated work), so — like
// `/api/outcomes/:id/verdict` — it requires the server-derived loopback
// localadmin session; a remote readonly token never reaches this route
// (`/api/conversation` is not in `security.ts`'s remote-safe allowlist).
const ASK_CONVERSATION_VOICE_HUB_TIMEOUT_MS = 3000;

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
      const viewer = resolvePresenceStudioViewerContext(req);
      const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
      const role = frontDeskRoleFromViewer({ role: toFrontDeskViewerScope(viewer).role });
      const items = resolveFrontDeskMenu({
        currentSurface: 'presence-studio',
        ports: readFrontDeskSurfacePorts(),
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
      const viewer = resolvePresenceStudioViewerContext(req);
      const requestedTenant = readSurfaceStringParam(req.query.tenant);
      // Same rule as the headless overview (`presenceStudioRecordInScope`):
      // `?tenant=` only narrows, and records with no tenant are denied for a
      // scoped viewer rather than shown to everyone.
      const scopedViewer = {
        ...viewer,
        tenantSlugs: narrowPresenceStudioTenant(viewer, requestedTenant),
      };

      const approvals: HomeDecideCandidateInput[] = listApprovalRequests({ status: 'pending' })
        .filter((record) => presenceStudioRecordInScope(scopedViewer, record))
        .map((record) => ({
          id: record.id,
          title: record.title,
          tenant_slug: record.scope?.tenant_slug,
          when: record.requestedAt,
        }));

      const heldActions: HomeDecideCandidateInput[] = presenceStudioData.cloudflareOsSurface
        .snapshot(undefined, viewer)
        .heldActions.filter((item) => item.status === 'pending')
        .filter((item) =>
          presenceStudioRecordInScope(scopedViewer, { tenant_slug: item.tenantSlug })
        )
        .map((item) => ({
          id: item.id,
          title: item.op || item.id,
          tenant_slug: item.tenantSlug,
          when: item.submittedAt,
        }));

      const taskSessions: HomeTaskSessionInput[] = listTaskSessions('presence')
        .filter((session) => presenceStudioRecordInScope(scopedViewer, session))
        .map((session) => ({
          id: session.session_id,
          title: session.goal?.summary || session.session_id,
          status: session.status,
          when: session.updated_at,
        }));

      const artifacts: HomeArtifactInput[] = listArtifactRecords()
        .filter((record) => presenceStudioRecordInScope(scopedViewer, record))
        .map((record) => ({
          id: record.artifact_id,
          title: deriveHomeArtifactTitle(record),
        }));

      const payload = buildHomePayload({
        now: new Date(),
        approvals,
        heldActions,
        taskSessions,
        artifacts,
      });
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
      const scopedViewer = {
        ...viewer,
        tenantSlugs: narrowPresenceStudioTenant(viewer, requestedTenant),
      };

      const taskSessions: ProgressTaskSessionInput[] = listTaskSessions('presence')
        .filter((session) => presenceStudioRecordInScope(scopedViewer, session))
        .map((session) => ({
          id: session.session_id,
          title: session.goal?.summary || session.session_id,
          status: session.status,
          when: session.updated_at,
          history: progressHistoryFromTaskSession(session),
        }));

      const inboxEntries = listInboxEntries({ limit: 1000 });
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
      res.json(payload);
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
      const scopedViewer = {
        ...viewer,
        tenantSlugs: narrowPresenceStudioTenant(viewer, requestedTenant),
      };

      const directSession = presenceStudioData.findTaskSession(id);
      const artifact = directSession
        ? undefined
        : listArtifactRecords().find((record) => record.artifact_id === id);
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
          listInboxEntries({ limit: 1000 }),
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
      const { status, note } = parsed.data;
      const updated =
        status === 'accepted'
          ? acceptInboxEntryWithHumanReceipt({
              entryId,
              actorId: viewer.principalId,
              authenticated: true,
              authMethod: 'surface_session',
              responsibilityStatement: 'I accept this deliverable on behalf of the operator.',
            })
          : markInboxEntry(entryId, 'rejected', {
              verdictNote: note,
              reviewedBy: viewer.principalId,
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

  app.post('/api/conversation', async (req, res) => {
    const parsed = presenceStudioConversationSchema.safeParse(
      presenceStudioData.safeParsePresenceStudioRequestBody(req.body, 'conversation body')
    );
    if (!parsed.success) {
      return res
        .status(400)
        .json({ ok: false, error: presenceStudioData.validationErrorMessage(parsed.error) });
    }

    let viewer: ReturnType<typeof resolvePresenceStudioViewerContext>;
    try {
      viewer = resolvePresenceStudioViewerContext(req);
      requirePresenceStudioLocalAdmin(viewer);
    } catch (error) {
      const status = error instanceof PresenceStudioViewerError ? error.status : 500;
      logger.warn(
        presenceStudioData.presenceStudioAuditLine(req, 'conversation.reject', {
          status,
          error: error instanceof Error ? error.message : String(error),
        })
      );
      return res.status(status).json(presenceStudioData.presenceStudioWireError(error, status));
    }

    const { text, session_id: sessionId } = parsed.data;
    const locale = normalizeLocale(parsed.data.locale) ?? 'en';
    const requestId = randomUUID();
    const scope = presenceStudioConversationScope(viewer);

    function deliverAskReply(
      rawReply: string,
      mode: 'voice-hub' | 'orchestrator',
      intentResolution: IntentResolutionContract | undefined
    ) {
      const view: AskConversationView = intentResolution
        ? viewFromIntentResolution(intentResolution)
        : { shape: 'reply' };
      // FD-09: resolve `normalized_intent` to human wording server-side so
      // `static/ask.js` never renders the raw internal slug — the
      // standard-intent catalog's own `description` when registered there,
      // else a humanized slug (see `resolveIntentLabel` module doc).
      const intentLabel = intentResolution
        ? resolveIntentLabel(
            intentResolution.normalized_intent,
            new Map(
              loadStandardIntentCatalog()
                .filter((intent): intent is typeof intent & { id: string } => Boolean(intent.id))
                .map((intent) => [intent.id, intent.description ?? ''])
            )
          )
        : undefined;
      const check = checkAndRepairSurfaceUxContract(rawReply, {
        allow_conversational_reply: isSimpleGreetingText(text),
        approval_required: intentResolution?.authority_level === 'approval_required',
      });
      if (!check.repaired && !check.verdict.valid) {
        logger.warn(
          `[presence-studio][ask] ${mode} reply violates surface UX contract: ${check.verdict.violations.join('; ')}`
        );
      }
      logger.info(
        presenceStudioData.presenceStudioAuditLine(req, 'conversation.complete', {
          request_id: requestId,
          mode,
          status: 200,
        })
      );
      return res.json({
        ok: true,
        reply: check.text,
        mode,
        shape: view.shape,
        ...(view.nextActions ? { next_actions: view.nextActions } : {}),
        ...(intentResolution ? { intent_resolution: intentResolution } : {}),
        ...(intentLabel
          ? { intent_label: intentLabel.label, intent_label_source: intentLabel.source }
          : {}),
        request_id: requestId,
      });
    }

    // Primary path: voice-hub (rich reply + TTS + presence reflection).
    try {
      const response = await fetch(`${presenceStudioData.VOICE_HUB_URL}/api/ingest-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: requestId,
          text,
          intent: 'conversation',
          source_id: 'ask-page',
          speaker: viewer.principalId,
          scope,
          reflect_to_surface: true,
          auto_reply: true,
        }),
        signal: AbortSignal.timeout(ASK_CONVERSATION_VOICE_HUB_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`voice-hub responded ${response.status}`);
      const parsedReply = parseAskVoiceHubReply(await response.json());
      if (!parsedReply) throw new Error('invalid voice-hub response');
      return deliverAskReply(parsedReply.reply, 'voice-hub', parsedReply.intentResolution);
    } catch (error) {
      logger.warn(
        `[presence-studio][ask] voice-hub path failed (${error instanceof Error ? error.message : String(error)}); falling back to the orchestrator`
      );
    }

    // Fallback path: call the orchestrator directly (no voice-hub needed).
    try {
      const conversation = await runSurfaceMessageConversation({
        surface: 'presence',
        text,
        locale,
        senderAgentId: 'kyberion:presence-studio',
        agentId: 'presence-surface-agent',
        actorId: viewer.principalId,
        threadTs: sessionId,
        cwd: pathResolver.rootDir(),
        scope,
      });
      const reply = typeof conversation?.text === 'string' ? conversation.text.trim() : '';
      if (!reply) throw new Error('empty orchestrator reply');
      return deliverAskReply(reply, 'orchestrator', conversation.intentResolution);
    } catch (error) {
      logger.warn(
        `[presence-studio][ask] orchestrator fallback failed (${error instanceof Error ? error.message : String(error)})`
      );
    }

    // Both paths failed — an honest, actionable message (never a silent or
    // fabricated reply).
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'conversation.unavailable', {
        request_id: requestId,
        status: 200,
      })
    );
    return res.json({
      ok: true,
      reply: catalogT('front_desk:ask_send_failed', undefined, locale),
      mode: 'unavailable',
      shape: 'reply',
      request_id: requestId,
    });
  });

  app.get('/api/onboarding/browser-state', (_req, res) => {
    try {
      const mic = probeMicCapture();
      res.json({ ...getBrowserOnboardingState(), readiness: { microphone: mic } });
    } catch (error: unknown) {
      res.status(500).json(presenceStudioData.presenceStudioWireError(error, 500));
    }
  });

  app.post('/api/onboarding/preview', (req, res) => {
    try {
      res.json(
        previewBrowserOnboarding(
          parseSafeJsonObjectValue(req.body ?? {}, 'browser onboarding preview body')
        )
      );
    } catch (error: any) {
      res.status(400).json(presenceStudioData.presenceStudioWireError(error, 400));
    }
  });

  app.post('/api/onboarding/apply', async (req, res) => {
    try {
      const result = await applyBrowserOnboarding(
        parseSafeJsonObjectValue(req.body ?? {}, 'browser onboarding apply body')
      );
      logger.info(
        presenceStudioData.presenceStudioAuditLine(req, 'onboarding/apply.complete', {
          artifacts: result.artifacts.length,
          status: 200,
        })
      );
      res.json(result);
    } catch (error: any) {
      logger.warn(
        presenceStudioData.presenceStudioAuditLine(req, 'onboarding/apply.reject', {
          status: 400,
          error: error?.message || String(error),
        })
      );
      res.status(400).json(presenceStudioData.presenceStudioWireError(error, 400));
    }
  });
}
