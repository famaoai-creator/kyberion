import { eventScopeMatches, type EventScope, type EventScopeInput } from '@agent/core/event-scope';
import { withExecutionContext } from '@agent/core/authority';
import { isRecord } from '@agent/core/foundation';
import { t } from '@agent/core/t';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import type { MissionProposal } from '@agent/core/channel-surface-types';
import {
  renderIntentAuthorityLabel,
  renderIntentOutcomeLabel,
} from '@agent/core/intent-resolution-contract';
import path from 'node:path';
import { readChronosJsonObject, type JsonObjectRequest } from '../../../lib/request-input';

export function chronosConversationScope(viewer: {
  tenantSlugs: string[] | 'all';
  tierAccess?: readonly ('personal' | 'confidential' | 'public')[];
}): EventScopeInput {
  const tenant =
    viewer.tenantSlugs !== 'all' && viewer.tenantSlugs.length === 1
      ? viewer.tenantSlugs[0]
      : undefined;
  const tier = viewer.tierAccess?.includes('confidential') ? 'confidential' : 'public';
  return tenant
    ? { scope_kind: 'tenant', tier, tenant_slug: tenant }
    : { scope_kind: 'system', tier: 'public' };
}

/**
 * Manual runtime controls are visible only when the runtime has an
 * authoritative scope that the resolved viewer can already read. The
 * request body cannot provide or widen this scope.
 */
export function chronosViewerCanAccessAgentScope(
  viewer: {
    tenantSlugs: string[] | 'all';
    tierAccess?: readonly ('personal' | 'confidential' | 'public')[];
  },
  scope: EventScope | undefined
): boolean {
  if (!scope) return false;
  const tierAccess = viewer.tierAccess ?? ['public', 'confidential'];
  if (!tierAccess.includes(scope.tier)) return false;
  return eventScopeMatches(scope, { tenant_slugs: viewer.tenantSlugs });
}

export function resolveChronosPipelineInputPath(rootDir: string, candidate: string): string | null {
  const normalized = candidate.trim().replaceAll('\\', '/');
  if (!normalized || path.isAbsolute(normalized)) return null;

  const resolved = path.resolve(rootDir, normalized);
  const relative = path.relative(rootDir, resolved).replaceAll('\\', '/');
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith('../') ||
    path.isAbsolute(relative) ||
    (!relative.startsWith('pipelines/') && relative !== 'pipelines') ||
    path.extname(relative) !== '.json'
  ) {
    return null;
  }
  return resolved;
}

export function parseChronosAgentBody(raw: unknown):
  | {
      ok: true;
      body: Record<string, unknown>;
      query?: string;
      requesterId: string;
    }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Chronos agent requests must use a JSON object body.' };
  }
  const body = raw as Record<string, unknown>;
  const allowedFields = new Set([
    'query',
    'intent',
    'locale',
    'action',
    'sessionId',
    'requesterId',
    'missionId',
    'teamRole',
  ]);
  const unexpected = Object.keys(body).find((field) => !allowedFields.has(field));
  if (unexpected) {
    return { ok: false, error: `Chronos agent field is not supported: ${unexpected}.` };
  }
  for (const field of [
    'query',
    'intent',
    'locale',
    'sessionId',
    'requesterId',
    'missionId',
    'teamRole',
  ]) {
    const value = body[field];
    if (value !== undefined && (typeof value !== 'string' || value.length > 100_000)) {
      return { ok: false, error: `Chronos agent ${field} must be a string.` };
    }
    if (typeof value === 'string' && /\p{Cc}/u.test(value)) {
      return { ok: false, error: `Chronos agent ${field} must not contain control characters.` };
    }
  }
  if (
    body.action !== undefined &&
    (typeof body.action !== 'string' ||
      !new Set(['approve_mission', 'reject_mission']).has(body.action))
  ) {
    return { ok: false, error: 'Chronos agent action is invalid.' };
  }
  const query = body.query !== undefined ? body.query : body.intent;
  if (query !== undefined && typeof query !== 'string') {
    return { ok: false, error: 'Chronos agent query must be a string.' };
  }
  return {
    ok: true,
    body,
    query: typeof query === 'string' ? query : undefined,
    requesterId:
      typeof body.requesterId === 'string' && body.requesterId.trim()
        ? body.requesterId
        : 'chronos-ui',
  };
}

export async function readChronosAgentBody(
  request: JsonObjectRequest
): Promise<ReturnType<typeof parseChronosAgentBody>> {
  const jsonBody = await readChronosJsonObject(request, 'Chronos agent');
  if (jsonBody.ok !== true) return { ok: false, error: jsonBody.error };
  return parseChronosAgentBody(jsonBody.body);
}

const CHRONOS_AGENT_ACTIONS = new Set([
  'spawn',
  'ask',
  'a2a',
  'logs',
  'snapshot',
  'refresh',
  'restart',
  'manual_peek',
  'manual_execute',
  'manual_resume',
  'manual_status',
  'manual_cancel',
]);

const CHRONOS_AGENT_STRING_FIELDS = [
  'provider',
  'agentId',
  'modelId',
  'systemPrompt',
  'query',
] as const;

const CHRONOS_AGENT_ALLOWED_FIELDS = new Set([
  'action',
  'provider',
  'agentId',
  'modelId',
  'systemPrompt',
  'query',
  'capabilities',
  'runtimeMetadata',
  'envelope',
  'limit',
  'logLimit',
  'actionId',
  'commandId',
]);

const CHRONOS_AGENT_STRING_LIMITS: Record<(typeof CHRONOS_AGENT_STRING_FIELDS)[number], number> = {
  provider: 128,
  agentId: 256,
  modelId: 256,
  systemPrompt: 100_000,
  query: 100_000,
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseChronosAgentsBody(
  raw: unknown,
  options: { requireAgentId?: boolean } = {}
): { ok: true; body: Record<string, unknown>; action: string } | { ok: false; error: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: 'Chronos agents requests must use a JSON object body.' };
  }

  const action = raw.action === undefined ? 'spawn' : raw.action;
  if (typeof action !== 'string' || !CHRONOS_AGENT_ACTIONS.has(action)) {
    return { ok: false, error: 'Chronos agents action is invalid.' };
  }

  const unexpected = Object.keys(raw).find((field) => !CHRONOS_AGENT_ALLOWED_FIELDS.has(field));
  if (unexpected) {
    return { ok: false, error: `Chronos agents field is not supported: ${unexpected}.` };
  }

  for (const field of CHRONOS_AGENT_STRING_FIELDS) {
    if (
      raw[field] !== undefined &&
      (typeof raw[field] !== 'string' || raw[field].length > CHRONOS_AGENT_STRING_LIMITS[field])
    ) {
      return { ok: false, error: `Chronos agents ${field} must be a string.` };
    }
  }

  for (const field of ['limit', 'logLimit'] as const) {
    if (
      raw[field] !== undefined &&
      (typeof raw[field] !== 'number' ||
        !Number.isInteger(raw[field]) ||
        raw[field] < 1 ||
        raw[field] > 500)
    ) {
      return { ok: false, error: `Chronos agents ${field} must be an integer from 1 to 500.` };
    }
  }

  if (
    raw.capabilities !== undefined &&
    (!Array.isArray(raw.capabilities) ||
      raw.capabilities.length > 64 ||
      raw.capabilities.some(
        (value) => typeof value !== 'string' || !value.trim() || value.length > 128
      ))
  ) {
    return { ok: false, error: 'Chronos agents capabilities must be an array of strings.' };
  }
  if (raw.runtimeMetadata !== undefined && !isRecord(raw.runtimeMetadata)) {
    return { ok: false, error: 'Chronos agents runtimeMetadata must be a JSON object.' };
  }
  if (raw.envelope !== undefined && !isRecord(raw.envelope)) {
    return { ok: false, error: 'Chronos agents envelope must be a JSON object.' };
  }
  if (
    raw.actionId !== undefined &&
    (typeof raw.actionId !== 'string' || raw.actionId.length > 256 || !raw.actionId.trim())
  ) {
    return { ok: false, error: 'Chronos agents actionId must be a non-empty string.' };
  }
  if (
    raw.commandId !== undefined &&
    (typeof raw.commandId !== 'string' || raw.commandId.length > 256 || !raw.commandId.trim())
  ) {
    return { ok: false, error: 'Chronos agents commandId must be a non-empty string.' };
  }

  if (options.requireAgentId && !nonEmptyString(raw.agentId)) {
    return { ok: false, error: 'Chronos agents agentId must be a non-empty string.' };
  }
  if (action === 'spawn' && !options.requireAgentId && !nonEmptyString(raw.provider)) {
    return { ok: false, error: 'Chronos agents provider must be a non-empty string.' };
  }
  if (
    [
      'logs',
      'snapshot',
      'ask',
      'refresh',
      'restart',
      'manual_peek',
      'manual_execute',
      'manual_resume',
      'manual_status',
      'manual_cancel',
    ].includes(action) &&
    !nonEmptyString(raw.agentId)
  ) {
    return { ok: false, error: 'Chronos agents agentId must be a non-empty string.' };
  }
  if (action === 'manual_execute' && !nonEmptyString(raw.actionId)) {
    return { ok: false, error: 'Chronos agents actionId must be a non-empty string.' };
  }
  if (action === 'manual_status' && !nonEmptyString(raw.commandId)) {
    return { ok: false, error: 'Chronos agents commandId must be a non-empty string.' };
  }
  if (action === 'manual_resume' && !nonEmptyString(raw.commandId)) {
    return { ok: false, error: 'Chronos agents commandId must be a non-empty string.' };
  }
  if (action === 'manual_cancel' && !nonEmptyString(raw.commandId)) {
    return { ok: false, error: 'Chronos agents commandId must be a non-empty string.' };
  }
  if (action === 'ask' && !nonEmptyString(raw.query)) {
    return { ok: false, error: 'Chronos agents query must be a non-empty string.' };
  }
  if (action === 'a2a' && (!isRecord(raw.envelope) || !isRecord(raw.envelope.header))) {
    return { ok: false, error: 'Chronos agents envelope.header must be a JSON object.' };
  }

  return { ok: true, body: raw, action };
}

export function intentResolutionA2ui(
  contract: {
    normalized_intent: string;
    missing_inputs: string[];
    authority_level: string;
    outcome_kind: string;
    next_action: { kind: string; label: string; consequence: string };
  },
  locale: SupportedLocale = 'en'
) {
  const authorityValue = renderIntentAuthorityLabel(
    contract.authority_level as Parameters<typeof renderIntentAuthorityLabel>[0],
    locale
  );
  const outcomeValue = renderIntentOutcomeLabel(
    contract.outcome_kind as Parameters<typeof renderIntentOutcomeLabel>[0],
    locale
  );
  const labels = {
    title: t('dock.intent_resolution.title', undefined, locale),
    understanding: t('bridge:contract_understanding', undefined, locale),
    missingInput: t('bridge:contract_missing_input', undefined, locale),
    nextAction: t('bridge:contract_next_action', undefined, locale),
    authority: t('bridge:contract_authority', undefined, locale),
    outcome: t('bridge:contract_outcome', undefined, locale),
    consequence: t('bridge:contract_consequence', undefined, locale),
    none: t('bridge:contract_none', undefined, locale),
  };
  return [
    {
      type: 'display:section',
      props: {
        title: labels.title,
        items: [
          {
            type: 'display:kv',
            props: {
              entries: [
                { key: labels.understanding, value: contract.normalized_intent },
                {
                  key: labels.missingInput,
                  value:
                    contract.missing_inputs.length > 0
                      ? contract.missing_inputs.join(', ')
                      : labels.none,
                },
                { key: labels.nextAction, value: contract.next_action.label },
                { key: labels.authority, value: authorityValue },
                { key: labels.outcome, value: outcomeValue },
                { key: labels.consequence, value: contract.next_action.consequence },
              ],
            },
          },
        ],
      },
    },
  ];
}

export function withMissionRole<T>(role: string, fn: () => T): T {
  return withExecutionContext(role, fn);
}

export function sanitizeMissionSlug(value: string): string {
  return (
    value
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'REQUEST'
  );
}

export function buildSurfaceMissionId(
  prefix: string,
  threadTs: string,
  proposal: MissionProposal,
  sourceText?: string
): string {
  const base = proposal.summary || sourceText || proposal.why || proposal.mission_type || 'request';
  const slug = sanitizeMissionSlug(base);
  const numericThread = threadTs.replace(/\D+/g, '').slice(-8) || Date.now().toString().slice(-8);
  return `MSN-${prefix}-${slug}-${numericThread}`;
}
