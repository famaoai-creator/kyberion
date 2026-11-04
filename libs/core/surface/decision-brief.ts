/**
 * Decision brief — what a person needs to decide an approval from the card
 * alone: 決めてほしいこと (ask), なぜ必要か (why), 影響 (what approve / reject
 * does, whether it can be undone, the risk), 推奨 (recommendation), 期限
 * (deadline) and who asked. Machine text (raw title and summary, ids, paths,
 * hashes) goes to `details`, which a surface shows only behind a disclosure.
 *
 * Pure and display-only: it never changes what is decided. The approval store
 * stays the only record, and the decision still binds to the record's
 * presented digest. The only extra input, `publication`, is the content of
 * the PR the request would create — the caller reads it from the
 * content-addressed review artifact the record's summary names, so it is
 * bound by that digest too (see `readApprovalPublicationPreview`).
 *
 * Strings come back as concierge vocabulary keys (`ux_a_*`) plus params so a
 * browser can localize them; text that is already human (a stored decision
 * card question, a justification) is passed through stripped and clamped.
 */

import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import {
  describeActor,
  humanizeSummary,
  stripMachineText,
  type ActorNameLookup,
  type DisplayText,
} from './display-humanize.js';

export type { DisplayText } from './display-humanize.js';

export type DecisionBriefState = 'pending' | 'resolved' | 'expired';
export type DecisionBriefRisk = 'low' | 'medium' | 'high' | 'critical';

export interface DecisionBriefDetail {
  /** Vocabulary key of the row label. */
  labelKey: string;
  value: string;
}

export interface DecisionBrief {
  /** Known effect the request binds (`vcs:pr_create`, …), when one is recognised. */
  effectId?: string;
  ask: DisplayText;
  /** Long form of `ask` when it had to be shortened for the card. */
  askFull?: string;
  why: DisplayText[];
  onApprove: DisplayText;
  onReject: DisplayText;
  /** What happens when nobody answers. */
  ifSilent: DisplayText;
  /** `undefined` = the record does not say. */
  reversible?: boolean;
  risk?: DecisionBriefRisk;
  recommendation?: DisplayText;
  /** ISO instant after which the request no longer stands. */
  deadline?: string;
  requester: DisplayText;
  state: DecisionBriefState;
  /** Identical requests share this key, so a list can fold them into one ("同じ依頼が N 件"). */
  groupKey: string;
  /** Machine text, for the collapsed 詳細 disclosure only. */
  details: DecisionBriefDetail[];
}

/** The PR a `vcs:pr_create` request would open, read from its review artifact. */
export interface PublicationPreview {
  repository: string;
  title: string;
  head?: string;
  base?: string;
  draft?: boolean;
}

export type DecisionBriefSubject = Pick<
  ApprovalRequestRecord,
  | 'id'
  | 'kind'
  | 'channel'
  | 'title'
  | 'summary'
  | 'status'
  | 'requestedBy'
  | 'requestedAt'
  | 'expiresAt'
> &
  Partial<
    Pick<
      ApprovalRequestRecord,
      | 'subject'
      | 'details'
      | 'severity'
      | 'requestedByDisplayName'
      | 'requestedByContext'
      | 'target'
      | 'justification'
      | 'risk'
      | 'workflow'
      | 'accountability'
      | 'decisionCard'
      | 'veto'
      | 'steering'
      | 'scope'
      | 'consumption'
      | 'applyResult'
      | 'revocation'
      | 'correlationId'
    >
  >;

export interface DecisionBriefOptions {
  publication?: PublicationPreview;
  names?: ActorNameLookup;
  now?: number;
}

const ASK_CHARS = 160;
const LINE_CHARS = 220;
const RISK_LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'critical']);

function key(k: string, params?: Record<string, string | number>): DisplayText {
  return params ? { key: k, params } : { key: k };
}

function human(text: string | undefined, max = LINE_CHARS): DisplayText | undefined {
  const { short } = humanizeSummary(text, max);
  return short ? { text: short } : undefined;
}

/** `Approval required: vcs:pr_create` → `vcs:pr_create`. */
function titleAction(title: string): string {
  return title.replace(/^approval required:\s*/iu, '').trim();
}

/** The effect the request binds, most authoritative source first. */
export function approvalEffectId(record: DecisionBriefSubject): string | undefined {
  const candidates = [
    record.accountability?.effectBinding,
    record.subject,
    titleAction(record.title || ''),
  ];
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim();
    if (/^vcs:(pr_create|pr_merge|push)$/u.test(value)) return value;
    if (/^tenant:[^:]+:attest-provider:[^:]+$/u.test(value)) return 'tenant:attest-provider';
  }
  if (record.kind === 'secret_mutation' && record.target) return 'secret_mutation';
  if (record.steering?.kind === 'mission_lifecycle_verb') return 'mission:lifecycle';
  return undefined;
}

function briefState(record: DecisionBriefSubject, now: number): DecisionBriefState {
  if (record.status === 'expired' || record.status === 'cancelled') return 'expired';
  if (record.status !== 'pending') return 'resolved';
  if (record.consumption || record.applyResult?.appliedAt || record.revocation) return 'resolved';
  const expires = record.expiresAt ? Date.parse(record.expiresAt) : NaN;
  if (Number.isFinite(expires) && expires <= now) return 'expired';
  return 'pending';
}

function riskOf(record: DecisionBriefSubject): DecisionBriefRisk | undefined {
  const level = record.risk?.level ?? record.severity;
  return level && RISK_LEVELS.has(level) ? (level as DecisionBriefRisk) : undefined;
}

function ifSilent(record: DecisionBriefSubject): DisplayText {
  if (record.veto) {
    if (record.veto.proceedsAt)
      return key('ux_a_veto_if_silent', { deadline: record.veto.proceedsAt });
    return key('ux_a_veto_if_silent_window', { minutes: record.veto.windowMinutes });
  }
  return key('ux_a_decide_if_silent');
}

/** `Default action:\n- draft-only; …` → `draft-only`, or undefined for `unknown`. */
function defaultAction(summary: string): string | undefined {
  const match = /Default action:\s*\n?\s*-\s*([a-z_-]+)/iu.exec(summary);
  const value = match?.[1]?.toLowerCase().replace(/_/gu, '-');
  return value && value !== 'unknown' ? value : undefined;
}

function machineDetails(record: DecisionBriefSubject, effectId?: string): DecisionBriefDetail[] {
  const rows: DecisionBriefDetail[] = [
    { labelKey: 'ux_a_detail_request_id', value: record.id },
    { labelKey: 'ux_a_detail_title', value: record.title },
  ];
  if (effectId) rows.push({ labelKey: 'ux_a_detail_effect', value: effectId });
  rows.push({ labelKey: 'ux_a_detail_requested_by', value: record.requestedBy });
  rows.push({ labelKey: 'ux_a_detail_channel', value: `${record.kind} / ${record.channel}` });
  if (record.summary) rows.push({ labelKey: 'ux_a_detail_summary', value: record.summary });
  if (record.details && record.details !== record.summary)
    rows.push({ labelKey: 'ux_a_detail_more', value: record.details });
  return rows;
}

interface EffectCopy {
  ask: DisplayText;
  why?: DisplayText[];
  onApprove: DisplayText;
  onReject: DisplayText;
  reversible?: boolean;
  groupParts: string[];
}

function effectCopy(
  record: DecisionBriefSubject,
  effectId: string | undefined,
  publication: PublicationPreview | undefined
): EffectCopy | undefined {
  switch (effectId) {
    case 'vcs:pr_create': {
      const why = [key('ux_a_pr_create_why')];
      if (publication?.head && publication.base)
        why.push(key('ux_a_pr_branch', { head: publication.head, base: publication.base }));
      if (publication?.draft) why.push(key('ux_a_pr_draft'));
      return publication
        ? {
            ask: key('ux_a_pr_create_ask', {
              repo: publication.repository,
              title: publication.title,
            }),
            why,
            onApprove: key('ux_a_pr_create_on_approve', { repo: publication.repository }),
            onReject: key('ux_a_pr_create_on_reject'),
            reversible: true,
            groupParts: [
              publication.repository,
              publication.title,
              publication.head ?? '',
              publication.base ?? '',
            ],
          }
        : {
            ask: key('ux_a_pr_create_ask_generic'),
            why,
            onApprove: key('ux_a_pr_create_on_approve_generic'),
            onReject: key('ux_a_pr_create_on_reject'),
            reversible: true,
            // Without the PR's content only an identical effect is "the same request".
            groupParts: [record.accountability?.payloadHash ?? record.id],
          };
    }
    case 'vcs:pr_merge':
      return {
        ask: key('ux_a_pr_merge_ask'),
        onApprove: key('ux_a_pr_merge_on_approve'),
        onReject: key('ux_a_vcs_on_reject'),
        reversible: false,
        groupParts: [record.accountability?.payloadHash ?? record.id],
      };
    case 'vcs:push':
      return {
        ask: key('ux_a_push_ask'),
        onApprove: key('ux_a_push_on_approve'),
        onReject: key('ux_a_vcs_on_reject'),
        reversible: false,
        groupParts: [record.accountability?.payloadHash ?? record.id],
      };
    case 'tenant:attest-provider': {
      const binding = String(record.accountability?.effectBinding ?? record.correlationId ?? '');
      const match = /tenant:([^:]+):attest-provider:([^:]+)/u.exec(binding);
      const tenant = match?.[1] ?? record.scope?.tenant_slug ?? '';
      const provider = match?.[2] ?? '';
      return {
        ask: key('ux_a_attest_ask', { tenant, provider }),
        onApprove: key('ux_a_attest_on_approve', { tenant, provider }),
        onReject: key('ux_a_attest_on_reject', { provider }),
        reversible: false,
        groupParts: [tenant, provider],
      };
    }
    case 'secret_mutation': {
      const target = record.target!;
      return {
        ask: key('ux_a_secret_ask', {
          service: target.serviceId,
          secret: target.secretKey,
          mutation: target.mutation,
        }),
        onApprove: key('ux_a_secret_on_approve', { service: target.serviceId }),
        onReject: key('ux_a_secret_on_reject'),
        reversible: target.mutation !== 'delete',
        groupParts: [target.serviceId, target.secretKey, target.mutation],
      };
    }
    case 'mission:lifecycle': {
      const steering = record.steering as { verb: string; missionId: string };
      return {
        ask: key('ux_a_mission_verb_ask', { mission: steering.missionId, verb: steering.verb }),
        onApprove: key('ux_a_mission_verb_on_approve', { verb: steering.verb }),
        onReject: key('ux_a_mission_verb_on_reject'),
        groupParts: [steering.missionId, steering.verb],
      };
    }
    default:
      return undefined;
  }
}

/**
 * Projects an approval request into the brief a card renders. Unknown effects
 * get a safe generic sentence built from the stored decision card or the
 * justification — never from the raw summary.
 */
export function buildDecisionBrief(
  record: DecisionBriefSubject,
  options: DecisionBriefOptions = {}
): DecisionBrief {
  const now = options.now ?? Date.now();
  const effectId = approvalEffectId(record);
  const known = effectCopy(record, effectId, options.publication);
  const card = record.decisionCard;
  const justification = record.justification;

  let ask: DisplayText;
  let askFull: string | undefined;
  if (known) {
    ask = known.ask;
  } else if (card?.question) {
    const clamped = humanizeSummary(card.question, ASK_CHARS);
    ask = clamped.short ? { text: clamped.short } : key('ux_a_generic_ask_unnamed');
    if (clamped.clamped) askFull = clamped.full;
  } else {
    const action = stripMachineText(titleAction(record.title || '')).text;
    ask = action ? key('ux_a_generic_ask', { action }) : key('ux_a_generic_ask_unnamed');
  }

  const why: DisplayText[] = [...(known?.why ?? [])];
  const reasonTexts = [justification?.reason, ...(card?.riskReasons ?? [])];
  for (const reason of reasonTexts) {
    const line = human(reason);
    if (
      line &&
      !why.some((entry) => 'text' in entry && entry.text === (line as { text: string }).text)
    )
      why.push(line);
  }
  if (why.length === 0) why.push(key('ux_a_generic_why'));

  const impact = human(justification?.impactSummary);
  const proposal = Boolean(record.veto || card?.level === 'veto');
  const onApprove =
    known?.onApprove ??
    impact ??
    key(proposal ? 'ux_a_proposal_on_approve' : 'ux_a_generic_on_approve');
  const onReject = record.veto
    ? key('ux_a_veto_on_reject')
    : (known?.onReject ?? key('ux_a_generic_on_reject'));

  const reversible = known?.reversible ?? card?.reversible;
  const recommendationText = card?.recommendation ? human(card.recommendation) : undefined;
  const fallbackDefault = defaultAction(record.summary || '');
  const recommendation =
    recommendationText ??
    (fallbackDefault ? key('ux_a_default_action', { action: fallbackDefault }) : undefined);

  const deadline = card?.deadline ?? record.veto?.proceedsAt ?? record.expiresAt;
  const tenant = record.scope?.tenant_slug ?? '';
  const askSignature = 'key' in ask ? `${ask.key}:${JSON.stringify(ask.params ?? {})}` : ask.text;
  const groupKey = [tenant, effectId ?? record.channel, ...(known?.groupParts ?? []), askSignature]
    .join('|')
    .toLowerCase();

  const requester = record.requestedByDisplayName
    ? { text: record.requestedByDisplayName }
    : describeActor(record.requestedBy, options.names);

  return {
    ...(effectId ? { effectId } : {}),
    ask,
    ...(askFull ? { askFull } : {}),
    why: why.slice(0, 4),
    onApprove,
    onReject,
    ifSilent: ifSilent(record),
    ...(reversible !== undefined ? { reversible } : {}),
    ...(riskOf(record) ? { risk: riskOf(record) } : {}),
    ...(recommendation ? { recommendation } : {}),
    ...(deadline ? { deadline } : {}),
    requester,
    state: briefState(record, now),
    groupKey,
    details: machineDetails(record, effectId),
  };
}

/** The review artifact a pr_create summary names (`- Created active/…/pr-publication/<run>/<sha>.json`). */
const PR_REVIEW_ARTIFACT =
  /\bactive\/shared\/artifacts\/(confidential\/([a-z0-9][a-z0-9-]*)|personal\/shared)\/evidence\/pr-publication\/[0-9a-f]{64}\/([0-9a-f]{64})\.json\b/u;

export interface PublicationArtifactRef {
  path: string;
  /** Content hash the file name claims (`computeApprovalPayloadHash` of the effect). */
  contentHash: string;
  tenantSlug?: string;
}

/** Locates the review artifact a `vcs:pr_create` request summary points to, if it is well formed. */
export function publicationArtifactRef(
  record: Pick<DecisionBriefSubject, 'summary' | 'scope'>
): PublicationArtifactRef | undefined {
  const match = PR_REVIEW_ARTIFACT.exec(record.summary || '');
  if (!match) return undefined;
  const tenantSlug = match[2];
  // The artifact must sit in the request's own tenant floor (or personal when untenanted).
  if ((record.scope?.tenant_slug ?? undefined) !== tenantSlug) return undefined;
  return { path: match[0], contentHash: match[3]!, ...(tenantSlug ? { tenantSlug } : {}) };
}

/** Validates the parsed artifact into the preview fields; anything else is dropped. */
export function parsePublicationPreview(value: unknown): PublicationPreview | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const repository = record.repository as Record<string, unknown> | undefined;
  const slug = typeof repository?.slug === 'string' ? repository.slug.trim() : '';
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  // owner/name, each starting with a letter or digit (no `..`, no leading dot).
  if (!/^[A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w.-]*$/u.test(slug) || !title) return undefined;
  const ref = (v: unknown) =>
    typeof v === 'string' && /^[\w./-]{1,200}$/u.test(v) ? v : undefined;
  const head = ref(record.head);
  const base = ref(record.base);
  return {
    repository: slug,
    title: title.length > 120 ? `${title.slice(0, 119)}…` : title,
    ...(head ? { head } : {}),
    ...(base ? { base } : {}),
    ...(record.draft === true ? { draft: true } : {}),
  };
}

/** Pending briefs first, soonest deadline first, then the oldest request. */
export function compareDecisionUrgency(
  a: { brief?: Pick<DecisionBrief, 'deadline' | 'state' | 'risk'>; requested_at?: string },
  b: { brief?: Pick<DecisionBrief, 'deadline' | 'state' | 'risk'>; requested_at?: string }
): number {
  const stateRank = (s?: DecisionBriefState) => (s === 'pending' || !s ? 0 : 1);
  const byState = stateRank(a.brief?.state) - stateRank(b.brief?.state);
  if (byState) return byState;
  const deadline = (v?: string) => {
    const ms = v ? Date.parse(v) : NaN;
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
  };
  const byDeadline = deadline(a.brief?.deadline) - deadline(b.brief?.deadline);
  if (byDeadline) return byDeadline < 0 ? -1 : 1;
  const riskRank = (r?: DecisionBriefRisk) =>
    r === 'critical' ? 0 : r === 'high' ? 1 : r === 'medium' ? 2 : 3;
  const byRisk = riskRank(a.brief?.risk) - riskRank(b.brief?.risk);
  if (byRisk) return byRisk;
  return String(a.requested_at ?? '').localeCompare(String(b.requested_at ?? ''));
}

/** Folds items whose briefs share a group key; the first (most urgent) item leads each group. */
export function groupByDecision<T extends { brief?: Pick<DecisionBrief, 'groupKey'> }>(
  items: readonly T[]
): Array<{ lead: T; others: T[] }> {
  const groups = new Map<string, { lead: T; others: T[] }>();
  const order: Array<{ lead: T; others: T[] }> = [];
  items.forEach((item, index) => {
    const k = item.brief?.groupKey ?? `__solo_${index}`;
    const existing = groups.get(k);
    if (existing) existing.others.push(item);
    else {
      const group = { lead: item, others: [] as T[] };
      groups.set(k, group);
      order.push(group);
    }
  });
  return order;
}
