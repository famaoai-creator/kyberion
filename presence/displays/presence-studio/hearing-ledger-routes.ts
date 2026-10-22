// SD-02 / SD-03 / SD-04: the hearing surface as the entrance of the decision
// ledger (SSOD = Single Source of Decisions). See
// docs/developer/improvement-plans-2026-09/SSOD_HEARING_INTEGRATION_PLAN_2026-09-14.ja.md
// §1.3 (requirement id = decision id) and §2.2 (level × actor).
//
// Two seams:
//   GET  /api/hearing/decisions/agenda?case=<id>&actor=product|customer
//        → `pnpm decisions ask` rendered as a hearing scenario the /ask page opens with
//   POST /api/hearing/:session/record-decisions
//        → answered requirements become promotion requests; the ledger write goes
//          through the governed facade `dist/scripts/decisions.js import` as a built
//          subprocess (never a library import of `scripts/**`, same boundary as
//          `hearing-mission-routes.ts`). Product levels decided by an owner/approver
//          land as `decided`; a customer's value lands as `proposed` until its
//          approval evidence is recorded (`on_behalf_of.evidence`), and the
//          response names who to ask. A greenfield hearing (`web_app_build`)
//          becomes a product concept (`PC-*`) in the same ledger.
//
// Reads of the tenant ledger run under `ecosystem_architect` like every other
// tenant-knowledge read in this surface; the tenant itself is the viewer's
// server-side namespace, never a request parameter.
import type express from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { nowIso } from '@agent/core/foundation';
import { t as catalogT } from '@agent/core/t';
import { normalizeLocale } from '@agent/core/locale-normalize';
import { readSurfaceStringParam } from '@agent/core/surface/surface-request-input';
import { withExecutionContext } from '@agent/core/authority';
import { logger } from '@agent/core/core';
import { humanActor } from '@agent/core/actor';
import { resolveMemberByPrincipal } from '@agent/core/organization/member-registry';
import { frontDeskRoleFromViewerScope, type FrontDeskRole } from '@agent/core/front-desk-identity';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import {
  CUSTOMER_ACTOR_ID_PATTERN,
  CUSTOMER_SLUG_PATTERN,
  DECISION_LEDGER_ROLES,
  askLedger,
  buildHearingScenarioFromAsk,
  buildProjectionBrief,
  readObserved,
  hearingAnswersToProductConcept,
  hearingAnswersToPromotions,
  isValidCaseId,
  parseDecisionsScenarioId,
  readLedger,
  type DecisionDecidedBy,
  type LedgerHearingScenario,
} from '@agent/core/decision-ledger';
import {
  PresenceStudioViewerError,
  requirePresenceStudioLocalAdmin,
  toFrontDeskViewerScope,
  type PresenceStudioViewerContext,
} from './security.js';
import { hearingNamespace, saveHearingRecord } from './hearing-runtime.js';
import { resolveHearingRequestViewer } from './hearing-request-scope.js';
import { hearingStorageForViewer } from './hearing-storage-access.js';
import { renderLedgerProjectionCanvas } from './hearing-ledger-canvas.js';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import {
  HEARING_SAFE_ID_PATTERN,
  type HearingDecidedBy,
  type HearingRecord,
  type HearingScenario,
} from './hearing.js';
import * as presenceStudioData from './presence-studio-runtime-data.js';

/** Runtime wiring of this surface to the governed facade — the one place these values live. */
const LEDGER_RUNTIME = {
  /** Built facade the ledger writes go through (never imported as a library). */
  facadeRelative: 'dist/scripts/decisions.js',
  /** sharedTmp namespace for the pending JSONL handed to the facade (24h TTL floor). */
  pendingTmpNamespace: 'hearing-ledger',
  /** Upper bound for one facade invocation. */
  facadeTimeoutMs: 60_000,
} as const;

export class HearingLedgerRequestError extends Error {
  readonly status = 400 as const;
}

/** Additive fields this route owns on the hearing record (intersection type, never on the base). */
export interface HearingLedgerFields {
  ledger_case?: string;
  ledger_result?: {
    at: string;
    decided: string[];
    proposed: Array<{ id: string; reason?: string; ask?: string }>;
    concepts: string[];
  };
}
export type HearingRecordWithLedger = HearingRecord & HearingLedgerFields;

/** Mirrors `scripts/decisions.ts` `DecisionImportSummary` — duplicated on purpose (surface never imports scripts). */
interface DecisionImportSummaryWire {
  dry_run: boolean;
  promoted: Array<{ promote: string; outcome: string; reason?: string; ask?: string; id?: string }>;
  appended: string[];
  concepts: string[];
  superseded: string[];
}

function tenantOfNamespace(namespace: string): string {
  if (namespace === 'all' || namespace === 'unscoped') {
    throw new HearingLedgerRequestError(
      'A tenant-scoped viewer is required for a decision hearing.'
    );
  }
  return namespace;
}

/** `scenario_ref` on `/answer`: `decisions-<case>-<product|customer>` → a scenario built from the ledger's open decisions. */
export function resolveLedgerScenarioRef(
  namespace: string,
  ref: string
): HearingScenario | undefined {
  const parsed = parseDecisionsScenarioId(ref);
  if (!parsed) return undefined;
  const tenant = tenantOfNamespace(namespace);
  if (!isValidCaseId(parsed.case_id))
    throw new HearingLedgerRequestError('Invalid decision case id.');
  const ledger = withExecutionContext(
    DECISION_LEDGER_ROLES.read,
    () => readLedger({ tenantSlug: tenant, caseId: parsed.case_id }),
    undefined,
    tenant
  );
  const scenario = buildHearingScenarioFromAsk(askLedger(ledger), {
    caseId: parsed.case_id,
    actor: parsed.actor,
  });
  if (scenario.requirements.length === 0) {
    throw new HearingLedgerRequestError('This case has no open decisions for that actor.');
  }
  return toHearingScenario(scenario);
}

function toHearingScenario(scenario: LedgerHearingScenario): HearingScenario {
  return {
    id: scenario.id,
    requirements: scenario.requirements.map((item) => ({
      id: item.id,
      label_key: item.label_key,
      label_source: item.label_source,
      ...(item.label_text ? { label_text: item.label_text } : {}),
      ...(item.aliases ? { aliases: item.aliases } : {}),
    })),
  };
}

function hearingSessionId(req: Request): string {
  const sessionId = String(req.params.session || '').trim();
  if (!HEARING_SAFE_ID_PATTERN.test(sessionId)) {
    throw new HearingLedgerRequestError('Invalid hearing session id.');
  }
  return sessionId;
}

function respondError(req: Request, res: Response, error: unknown): void {
  const status =
    error instanceof HearingLedgerRequestError
      ? error.status
      : error instanceof PresenceStudioViewerError
        ? error.status
        : 500;
  logger.warn(
    presenceStudioData.presenceStudioAuditLine(req, 'hearing.ledger.reject', {
      status,
      error: error instanceof Error ? error.message : String(error),
    })
  );
  res.status(status).json(presenceStudioData.presenceStudioWireError(error, status));
}

function deciderRole(
  member: { memberships: ReadonlyArray<{ tenant_slug: string; role: FrontDeskRole }> },
  namespace: string,
  viewer: PresenceStudioViewerContext
): FrontDeskRole {
  const membership = member.memberships.find((item) => item.tenant_slug === namespace);
  return membership
    ? membership.role
    : frontDeskRoleFromViewerScope(toFrontDeskViewerScope(viewer));
}

function readOnBehalfOf(
  input: Record<string, unknown>
): DecisionDecidedBy['on_behalf_of'] | undefined {
  const raw = input.on_behalf_of;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const actorId = typeof value.actor_id === 'string' ? value.actor_id.trim() : '';
  if (!CUSTOMER_ACTOR_ID_PATTERN.test(actorId)) {
    throw new HearingLedgerRequestError('on_behalf_of.actor_id must be a customer actor id.');
  }
  return {
    actor_id: actorId,
    ...(typeof value.evidence === 'string' && value.evidence.trim()
      ? { evidence: value.evidence.trim() }
      : {}),
    ...(typeof value.confirm_target === 'string' && value.confirm_target.trim()
      ? { confirm_target: value.confirm_target.trim() }
      : {}),
  };
}

/** Pending lines for the facade: promotions for a ledger scenario, a concept for a greenfield one. */
export function buildLedgerImportLines(
  record: HearingRecord,
  options: { caseId: string; decidedBy: DecisionDecidedBy; now: string }
): { lines: string[]; kind: 'promotions' | 'concept' } {
  const parsed = parseDecisionsScenarioId(record.scenario);
  if (parsed) {
    const promotions = hearingAnswersToPromotions(record.requirements, {
      sessionId: record.session_id,
      decidedBy: options.decidedBy,
    });
    return { kind: 'promotions', lines: promotions.map((item) => JSON.stringify(item)) };
  }
  const concept = hearingAnswersToProductConcept(record.requirements, {
    sessionId: record.session_id,
    scenario: record.scenario,
    recordedBy: { kind: 'human', id: options.decidedBy.id },
    now: options.now,
  });
  return { kind: 'concept', lines: [JSON.stringify({ concept })] };
}

function runFacadeImport(args: {
  tenant: string;
  caseId: string;
  lines: string[];
  customer?: string;
}): DecisionImportSummaryWire {
  const facade = assertSafeRepositoryPath(pathResolver.rootResolve(LEDGER_RUNTIME.facadeRelative));
  if (!safeExistsSync(facade)) {
    throw new Error(
      `[DECISION_LEDGER_FACADE_MISSING] build the repository first (${LEDGER_RUNTIME.facadeRelative})`
    );
  }
  const dir = pathResolver.sharedTmp(LEDGER_RUNTIME.pendingTmpNamespace);
  safeMkdir(dir, { recursive: true });
  const pending = assertSafeRepositoryPath(path.join(dir, `${randomUUID()}.jsonl`), {
    allowMissingLeaf: true,
  });
  safeWriteFile(pending, `${args.lines.join('\n')}\n`, { encoding: 'utf8' });
  try {
    const result = safeExecResult(
      process.execPath,
      [
        facade,
        'import',
        '--tenant',
        args.tenant,
        '--case',
        args.caseId,
        '--file',
        pending,
        ...(args.customer ? ['--customer', args.customer] : []),
        '--json',
      ],
      { cwd: pathResolver.rootDir(), encoding: 'utf8', timeoutMs: LEDGER_RUNTIME.facadeTimeoutMs }
    );
    const jsonLine = String(result.stdout || '')
      .trim()
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .pop();
    if (!jsonLine) {
      throw new Error(
        `[DECISION_LEDGER_FACADE_FAILED] ${String(result.stderr || '').trim() || 'no JSON result from decisions import'}`
      );
    }
    return JSON.parse(jsonLine) as DecisionImportSummaryWire;
  } finally {
    safeRmSync(pending, { force: true });
  }
}

/**
 * SD-05: for a ledger hearing (`decisions-<case>-<actor>` scenario), the canvas
 * is a deterministic projection of the tenant's ledger — decided rows with
 * their conformance verdict, open rows with the answer given so far. Returns
 * `undefined` for any other scenario so the caller keeps its template /
 * model-generated path; never throws for a missing ledger (an empty
 * projection is still a valid canvas).
 */
export function renderLedgerCanvasForRecord(
  namespace: string,
  record: HearingRecord,
  locale: SupportedLocale
): string | undefined {
  const parsed = parseDecisionsScenarioId(record.scenario);
  if (!parsed) return undefined;
  if (namespace === 'all' || namespace === 'unscoped') return undefined;
  if (!isValidCaseId(parsed.case_id)) return undefined;
  const location = { tenantSlug: namespace, caseId: parsed.case_id };
  const { ledger, observed } = withExecutionContext(
    DECISION_LEDGER_ROLES.read,
    () => ({
      ledger: readLedger(location),
      observed: readObserved(location),
    }),
    undefined,
    namespace
  );
  const brief = buildProjectionBrief(ledger, observed, {
    caseId: parsed.case_id,
    actor: parsed.actor,
    now: nowIso(),
    answers: record.requirements,
  });
  return renderLedgerProjectionCanvas(brief, { locale, tenantSlug: namespace });
}

export function registerHearingLedgerRoutes(app: express.Express): void {
  app.get('/api/hearing/decisions/agenda', (req, res) => {
    try {
      const viewer = resolveHearingRequestViewer(req);
      const tenant = tenantOfNamespace(hearingNamespace(viewer.tenantSlugs));
      const caseId = readSurfaceStringParam(req.query.case) ?? '';
      const actorParam = readSurfaceStringParam(req.query.actor);
      const actor = actorParam === 'customer' ? 'customer' : 'product';
      if (!isValidCaseId(caseId)) throw new HearingLedgerRequestError('Invalid decision case id.');
      const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
      const ledger = withExecutionContext(
        DECISION_LEDGER_ROLES.read,
        () => readLedger({ tenantSlug: tenant, caseId }),
        undefined,
        tenant
      );
      const scenario = buildHearingScenarioFromAsk(askLedger(ledger), { caseId, actor });
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        scenario: toHearingScenario(scenario),
        open: scenario.ledger.open,
        label: catalogT('front_desk:hearing_ledger_agenda', { open: scenario.ledger.open }, locale),
      });
    } catch (error) {
      respondError(req, res, error);
    }
  });

  app.post('/api/hearing/:session/record-decisions', (req, res) => {
    try {
      const viewer = resolveHearingRequestViewer(req);
      requirePresenceStudioLocalAdmin(viewer);
      const sessionId = hearingSessionId(req);
      const storage = hearingStorageForViewer(viewer);
      const namespace = storage.namespace;
      const tenant = tenantOfNamespace(namespace);
      const record = storage.load(sessionId) as HearingRecordWithLedger | null;
      if (!record) throw new HearingLedgerRequestError('Hearing record does not exist yet.');
      const body = presenceStudioData.safeParsePresenceStudioRequestBody(
        req.body,
        'hearing record decisions'
      );
      const input =
        body && typeof body === 'object' && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {};
      const parsedScenario = parseDecisionsScenarioId(record.scenario);
      const caseId =
        parsedScenario?.case_id ??
        (typeof input.case === 'string' ? input.case.trim() : (record.ledger_case ?? ''));
      if (!isValidCaseId(caseId)) {
        throw new HearingLedgerRequestError('A decision case id is required for this hearing.');
      }
      const answered = record.requirements.filter((item) => item.answer?.trim());
      if (answered.length === 0) {
        throw new HearingLedgerRequestError('Nothing has been answered yet.');
      }
      const member = withExecutionContext(DECISION_LEDGER_ROLES.memberLookup, () =>
        resolveMemberByPrincipal({ principalId: viewer.principalId, source: viewer.source })
      );
      if (!member) {
        throw new PresenceStudioViewerError(
          403,
          'decisions are recorded for registered members only'
        );
      }
      const role = deciderRole(member, namespace, viewer);
      if (role !== 'owner' && role !== 'approver') {
        // Same positive allowlist as the hearing decide route: only
        // decision-capable membership roles record a decision. Operators
        // execute but never decide; viewers observe.
        throw new PresenceStudioViewerError(403, 'this member role cannot record decisions');
      }
      const actor = humanActor(member.member_id, member.display_name);
      const onBehalfOf = readOnBehalfOf(input);
      const decidedBy: DecisionDecidedBy = {
        kind: 'human',
        id: actor.id,
        ...(actor.display_name ? { display_name: actor.display_name } : {}),
        role,
        ...(onBehalfOf ? { on_behalf_of: onBehalfOf } : {}),
      };
      const now = nowIso();
      const { lines, kind } = buildLedgerImportLines(record, { caseId, decidedBy, now });
      const customer =
        typeof input.customer === 'string' && CUSTOMER_SLUG_PATTERN.test(input.customer)
          ? input.customer
          : undefined;
      const summary = runFacadeImport({ tenant, caseId, lines, customer });
      const decided = summary.promoted.filter((item) => item.outcome === 'decided');
      const proposed = summary.promoted.filter((item) => item.outcome === 'proposed');
      const hearingDecidedBy: HearingDecidedBy = {
        kind: 'human',
        id: actor.id,
        ...(actor.display_name ? { display_name: actor.display_name } : {}),
        role,
      };
      const next: HearingRecordWithLedger = {
        ...record,
        ledger_case: caseId,
        ledger_result: {
          at: now,
          decided: decided.map((item) => item.id ?? item.promote),
          proposed: proposed.map((item) => ({
            id: item.id ?? item.promote,
            ...(item.reason ? { reason: item.reason } : {}),
            ...(item.ask ? { ask: item.ask } : {}),
          })),
          concepts: summary.concepts,
        },
        ...(decided.length > 0 || kind === 'concept'
          ? { decided_by: hearingDecidedBy, decided_at: now }
          : {}),
        updated_at: now,
      };
      saveHearingRecord(namespace, next);
      const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
      const pendingOnly = decided.length === 0 && kind === 'promotions';
      const labelKey = pendingOnly
        ? 'front_desk:hearing_next_ledger_pending'
        : 'front_desk:hearing_next_ledger_recorded';
      res.json({
        ok: true,
        record: next,
        result: summary,
        next_action: {
          kind: pendingOnly ? 'ledger_pending' : 'ledger_recorded',
          label_key: labelKey,
          label: catalogT(labelKey, undefined, locale),
          ...(proposed.find((item) => item.ask)
            ? { ask: proposed.find((item) => item.ask)?.ask }
            : {}),
        },
      });
    } catch (error) {
      respondError(req, res, error);
    }
  });
}
