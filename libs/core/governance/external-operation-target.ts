import { operationAuthorization } from '../foundation/authorization-registry.js';
import './authorization-overlay.js';

/**
 * Explicit targets signed by the accountable human. The only pattern field is
 * `branch_pattern` — a single trailing wildcard over a literal tree prefix
 * ('feat/*' covers every branch under feat/) — no other wildcard matching.
 */
export type ExternalOperationGrant =
  | {
      operation_id: 'vcs:pr_create';
      repository: string;
      /** Nonpublic runs additionally need exact charter data scope and a verified-private repo. */
      visibility?: 'private';
    }
  | {
      operation_id: 'vcs:pr_merge' | 'vcs:push';
      repository: string;
      branch: string;
      visibility?: 'private';
    }
  | {
      operation_id: 'vcs:pr_merge' | 'vcs:push';
      repository: string;
      /** Signed tree-prefix delegation, e.g. 'feat/*' — never matches 'main'. */
      branch_pattern: string;
      visibility?: 'private';
    }
  | { operation_id: 'browser:goto' | 'browser:open_tab'; origin?: string }
  | {
      operation_id: 'tenant:attest_provider';
      tenant_slug: string;
      provider: string;
      training_use: 'none';
      plan: string;
      basis: string;
      attested_by: string;
    }
  | { operation_id: 'service:slack:preset:post_message'; channel?: string }
  | {
      operation_id: 'meeting:join' | 'meeting:listen' | 'meeting:speak' | 'meeting:chat';
      platform: string;
      meeting_id: string;
    }
  | {
      operation_id: 'meeting:join' | 'meeting:listen' | 'meeting:speak' | 'meeting:chat';
      platform: string;
      series_id: string;
    }
  | { operation_id: 'voice:playback'; platform?: string; format?: string; content_hash?: string }
  | { operation_id: 'voice:speak'; platform?: string }
  | { operation_id: 'network:fetch'; method?: string; origin?: string }
  | { operation_id: 'network:exposure_check'; origin?: string }
  | { operation_id: 'network:shell'; cmd?: string }
  | { operation_id: 'network:a2a_send'; method?: string; peer_id?: string }
  | { operation_id: 'calendar:create_event'; backend?: string; calendar_id?: string }
  | {
      operation_id: 'calendar:update_event' | 'calendar:delete_event';
      backend?: string;
      calendar_id?: string;
      event_id?: string;
    }
  | {
      operation_id: 'deployment:deploy_release';
      adapter?: string;
      environment?: string;
      project_name?: string;
    }
  | {
      operation_id:
        | 'media:generation:generate_image'
        | 'media:generation:generate_video'
        | 'media:generation:generate_music'
        | 'media:generation:run_workflow';
      backend?: string;
    };

/**
 * Declarative delegation registry: one entry per operation that may consult
 * an exact charter grant. Adding a same-shaped operation is one line; a new
 * target shape adds one extractor. Boundaries, the grant parser, the runtime
 * resolver and the attach whitelist all read this table — a new delegable
 * operation needs no further wiring.
 */
export interface DelegationTargetSpec {
  /** Canonical grant fields besides `operation_id` (sorted order in grants). */
  readonly fields: readonly string[];
  /** Grant fields that may be present or absent (exact-match still applies when present). */
  readonly optionalFields?: readonly string[];
  /** Exactly one of these optional fields must be present in a valid grant. */
  readonly requiredOneOf?: readonly string[];
  /** Normalize an effect into the raw grant object to match, or undefined. */
  readonly buildTarget: (effect: Record<string, unknown>) => unknown;
  /** Reputational class stamped on the delegated charter action. */
  readonly reputational_class: 'A' | 'B';
}

/** Verified-private repo markers flow from the effect into the grant target. */
function privateVisibility(effect: Record<string, unknown>): { visibility: 'private' } | undefined {
  return effect.repository_visibility === 'private' ? { visibility: 'private' } : undefined;
}

export function normalizeRepositoryTarget(rawUrl: string): string | undefined {
  try {
    const https = rawUrl.startsWith('git@')
      ? `https://${rawUrl.slice(4).replace(/:/, '/')}`
      : rawUrl.startsWith('ssh://')
        ? rawUrl.replace(/^ssh:\/\/(?:git@)?/, 'https://')
        : rawUrl;
    const url = new URL(https);
    const pathname = url.pathname.replace(/\.git$/, '').replace(/\/$/, '');
    return `${url.origin}${pathname}`;
  } catch {
    return undefined;
  }
}

function normalizeBranch(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const branch = raw.trim().replace(/^refs\/heads\//, '');
  if (!branch || branch.includes('*') || /[\s^~:?[\]\\]/.test(branch)) return undefined;
  return branch;
}

/**
 * One trailing wildcard over a literal tree prefix: 'feat/*' or 'feat/**'
 * canonicalize to 'feat/*' and match any branch starting with 'feat/'.
 * Bare '*', interior wildcards, and non-tree prefixes are rejected.
 */
function normalizeBranchPattern(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let canonical = raw.trim().replace(/^refs\/heads\//, '');
  // Collapse a trailing wildcard run to one '*' with a linear scan —
  // a regex quantifier here backtracks on attacker-controlled input.
  let lastNonWildcard = canonical.length;
  while (lastNonWildcard > 0 && canonical.charAt(lastNonWildcard - 1) === '*') lastNonWildcard--;
  if (lastNonWildcard < canonical.length) canonical = `${canonical.slice(0, lastNonWildcard)}*`;
  if (canonical.length < 3 || !canonical.endsWith('*')) return undefined;
  const prefix = canonical.slice(0, -1);
  if (!prefix.endsWith('/') || prefix.includes('*') || /[\s^~:?[\]\\]/.test(prefix))
    return undefined;
  return canonical;
}

export const EXTERNAL_OPERATION_DELEGATION: Record<string, DelegationTargetSpec> = {
  'vcs:pr_create': {
    fields: ['repository'],
    optionalFields: ['visibility'],
    buildTarget: (effect) => {
      if (
        !['public', 'inline', 'personal', 'confidential'].includes(String(effect.body_source_tier))
      )
        return undefined;
      if (
        effect.body_source_tier === 'confidential' &&
        (typeof effect.body_source_tenant !== 'string' || !effect.body_source_tenant)
      )
        return undefined;
      if (effect.body_source_tier !== 'confidential' && effect.body_source_tenant !== undefined)
        return undefined;
      const repository = effect.repository as
        { url?: unknown; host?: unknown; slug?: unknown } | undefined;
      if (typeof repository?.url !== 'string') return undefined;
      try {
        const url = new URL(repository.url);
        if (
          url.host !== repository.host ||
          url.pathname.replace(/^\//, '').replace(/\/$/, '') !== repository.slug
        )
          return undefined;
        return {
          operation_id: 'vcs:pr_create',
          repository: `${url.origin}${url.pathname.replace(/\/$/, '')}`,
          ...privateVisibility(effect),
        };
      } catch {
        return undefined;
      }
    },
    reputational_class: 'B',
  },
  'vcs:pr_merge': {
    fields: ['repository'],
    optionalFields: ['branch', 'branch_pattern', 'visibility'],
    requiredOneOf: ['branch', 'branch_pattern'],
    buildTarget: (effect) => {
      const repository = effect.repository as
        { url?: unknown; host?: unknown; slug?: unknown } | undefined;
      if (typeof repository?.url !== 'string' || typeof effect.baseRefName !== 'string')
        return undefined;
      try {
        const url = new URL(repository.url);
        if (
          url.host !== repository.host ||
          url.pathname.replace(/^\//, '').replace(/\/$/, '') !== repository.slug
        )
          return undefined;
        return {
          operation_id: 'vcs:pr_merge',
          repository: `${url.origin}${url.pathname.replace(/\/$/, '')}`,
          branch: effect.baseRefName,
          ...privateVisibility(effect),
        };
      } catch {
        return undefined;
      }
    },
    reputational_class: 'A',
  },
  'vcs:push': {
    fields: ['repository'],
    optionalFields: ['branch', 'branch_pattern', 'visibility'],
    requiredOneOf: ['branch', 'branch_pattern'],
    buildTarget: (effect) => {
      if (typeof effect.url !== 'string' || typeof effect.destination !== 'string')
        return undefined;
      const repository = normalizeRepositoryTarget(effect.url);
      const branch = normalizeBranch(effect.destination);
      if (!repository || !branch) return undefined;
      return { operation_id: 'vcs:push', repository, branch, ...privateVisibility(effect) };
    },
    reputational_class: 'A',
  },
  'browser:goto': {
    fields: [],
    optionalFields: ['origin'],
    buildTarget: (effect) => buildBrowserNavigationTarget('browser:goto', effect),
    reputational_class: 'B',
  },
  'browser:open_tab': {
    fields: [],
    optionalFields: ['origin'],
    buildTarget: (effect) => buildBrowserNavigationTarget('browser:open_tab', effect),
    reputational_class: 'B',
  },
  'tenant:attest_provider': {
    fields: ['attested_by', 'basis', 'plan', 'provider', 'tenant_slug', 'training_use'],
    buildTarget: (effect) => {
      // Only the egress-opening claim is ever delegated; 'used'/'unknown'
      // attestations need no human approval, so there is nothing to grant.
      if (effect.training_use !== 'none') return undefined;
      const claim = {
        operation_id: 'tenant:attest_provider',
        tenant_slug:
          typeof effect.tenant_slug === 'string' ? effect.tenant_slug.trim() : effect.tenant_slug,
        provider: typeof effect.provider === 'string' ? effect.provider.trim() : effect.provider,
        training_use:
          typeof effect.training_use === 'string'
            ? effect.training_use.trim()
            : effect.training_use,
        plan: typeof effect.plan === 'string' ? effect.plan.trim() : effect.plan,
        basis: typeof effect.basis === 'string' ? effect.basis.trim() : effect.basis,
        attested_by:
          typeof effect.attested_by === 'string' ? effect.attested_by.trim() : effect.attested_by,
      };
      for (const key of [
        'tenant_slug',
        'provider',
        'training_use',
        'plan',
        'basis',
        'attested_by',
      ]) {
        const v = claim[key as keyof typeof claim];
        if (typeof v !== 'string' || !v) return undefined;
      }
      return claim;
    },
    reputational_class: 'A',
  },
  'service:slack:preset:post_message': {
    fields: [],
    optionalFields: ['channel'],
    buildTarget: (effect) => {
      const params = effect.params as { channel?: unknown } | undefined;
      const channel = nonEmptyString(params?.channel);
      return channel ? { operation_id: 'service:slack:preset:post_message', channel } : undefined;
    },
    reputational_class: 'B',
  },
  'meeting:join': meetingSessionDelegation('meeting:join'),
  'meeting:listen': meetingSessionDelegation('meeting:listen'),
  'meeting:chat': meetingSessionDelegation('meeting:chat'),
  'meeting:speak': meetingSessionDelegation('meeting:speak'),
  'voice:playback': {
    fields: [],
    optionalFields: ['platform', 'format', 'content_hash'],
    buildTarget: (effect) => {
      const params = effect.params as
        { platform?: unknown; format?: unknown; content_hash?: unknown } | undefined;
      const platform = nonEmptyString(params?.platform);
      if (!platform) return undefined;
      const format = nonEmptyString(params?.format);
      const content_hash = nonEmptyString(params?.content_hash);
      return {
        operation_id: 'voice:playback',
        platform,
        ...(format ? { format } : {}),
        ...(content_hash ? { content_hash } : {}),
      };
    },
    reputational_class: 'B',
  },
  'voice:speak': {
    fields: [],
    optionalFields: ['platform'],
    buildTarget: (effect) => {
      const params = effect.params as { platform?: unknown } | undefined;
      const platform = nonEmptyString(params?.platform);
      return platform ? { operation_id: 'voice:speak', platform } : undefined;
    },
    reputational_class: 'B',
  },
  'network:fetch': {
    fields: [],
    optionalFields: ['method', 'origin'],
    buildTarget: (effect) => {
      const params = effect.params as { url?: unknown; method?: unknown } | undefined;
      const origin = httpsOrigin(params?.url);
      const method = (nonEmptyString(params?.method) ?? 'GET').toUpperCase();
      return origin ? { operation_id: 'network:fetch', method, origin } : undefined;
    },
    reputational_class: 'A',
  },
  'network:exposure_check': {
    fields: [],
    optionalFields: ['origin'],
    buildTarget: (effect) => {
      const params = effect.params as { url?: unknown } | undefined;
      const origin = httpsOrigin(params?.url);
      return origin ? { operation_id: 'network:exposure_check', origin } : undefined;
    },
    reputational_class: 'B',
  },
  'network:shell': {
    fields: [],
    optionalFields: ['cmd'],
    buildTarget: (effect) => {
      const params = effect.params as { cmd?: unknown } | undefined;
      const cmd = nonEmptyString(params?.cmd);
      return cmd ? { operation_id: 'network:shell', cmd } : undefined;
    },
    reputational_class: 'A',
  },
  'network:a2a_send': {
    fields: [],
    optionalFields: ['method', 'peer_id'],
    buildTarget: (effect) => {
      const params = effect.params as { method?: unknown; message?: unknown } | undefined;
      const method = nonEmptyString(params?.method);
      const message = params?.message;
      if (!method || !message || typeof message !== 'object' || Array.isArray(message))
        return undefined;
      const record = message as Record<string, unknown>;
      const header =
        record.header && typeof record.header === 'object' && !Array.isArray(record.header)
          ? (record.header as Record<string, unknown>)
          : undefined;
      const peer = [
        record.recipient_peer_id,
        record.peer_id,
        record.to,
        header?.recipient_peer_id,
        header?.peer_id,
        header?.to,
      ].find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      return peer ? { operation_id: 'network:a2a_send', method, peer_id: peer } : undefined;
    },
    reputational_class: 'A',
  },
  'calendar:create_event': calendarDelegation('calendar:create_event', ['calendar_id']),
  'calendar:update_event': calendarDelegation('calendar:update_event', ['calendar_id', 'event_id']),
  'calendar:delete_event': calendarDelegation('calendar:delete_event', ['calendar_id', 'event_id']),
  'deployment:deploy_release': {
    fields: [],
    optionalFields: ['adapter', 'environment', 'project_name'],
    buildTarget: (effect) => {
      const adapter = nonEmptyString(effect.adapter);
      const params = effect.params as { environment?: unknown; project_name?: unknown } | undefined;
      const environment = nonEmptyString(params?.environment);
      if (!adapter || !environment) return undefined;
      const project_name = nonEmptyString(params?.project_name);
      return {
        operation_id: 'deployment:deploy_release',
        adapter,
        environment,
        ...(project_name ? { project_name } : {}),
      };
    },
    reputational_class: 'A',
  },
  'media:generation:generate_image': mediaGenerationDelegation('media:generation:generate_image'),
  'media:generation:generate_video': mediaGenerationDelegation('media:generation:generate_video'),
  'media:generation:generate_music': mediaGenerationDelegation('media:generation:generate_music'),
  'media:generation:run_workflow': mediaGenerationDelegation('media:generation:run_workflow'),
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Delegation only covers https origins — an http or credentialed URL falls
 * back to per-action approval. */
function httpsOrigin(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function meetingSessionDelegation(
  operationId: 'meeting:join' | 'meeting:listen' | 'meeting:speak' | 'meeting:chat'
): DelegationTargetSpec {
  return {
    fields: ['platform'],
    optionalFields: ['meeting_id', 'series_id'],
    requiredOneOf: ['meeting_id', 'series_id'],
    buildTarget: (effect) => {
      const params = effect.params as
        { platform?: unknown; meeting_id?: unknown; series_id?: unknown } | undefined;
      const platform = nonEmptyString(params?.platform);
      if (!platform) return undefined;
      // A grant names exactly one scope: the calendar series (standing
      // delegation for a recurring meeting) or the single meeting id. When
      // both are present the series id wins — it is the designed
      // standing-grant match for recording.
      const series_id = nonEmptyString(params?.series_id);
      const meeting_id = nonEmptyString(params?.meeting_id);
      if (series_id) return { operation_id: operationId, platform, series_id };
      if (meeting_id) return { operation_id: operationId, platform, meeting_id };
      return undefined;
    },
    reputational_class: 'B',
  };
}

function calendarDelegation(
  operationId: 'calendar:create_event' | 'calendar:update_event' | 'calendar:delete_event',
  optionalFields: readonly string[]
): DelegationTargetSpec {
  return {
    fields: [],
    optionalFields: ['backend', ...optionalFields],
    buildTarget: (effect) => {
      const backend = nonEmptyString(effect.backend);
      const params = effect.params as { calendar_id?: unknown; event_id?: unknown } | undefined;
      if (!backend) return undefined;
      const calendar_id = nonEmptyString(params?.calendar_id);
      const event_id = nonEmptyString(params?.event_id);
      return {
        operation_id: operationId,
        backend,
        ...(calendar_id ? { calendar_id } : {}),
        ...(event_id ? { event_id } : {}),
      };
    },
    reputational_class: 'A',
  };
}

function mediaGenerationDelegation(
  operationId:
    | 'media:generation:generate_image'
    | 'media:generation:generate_video'
    | 'media:generation:generate_music'
    | 'media:generation:run_workflow'
): DelegationTargetSpec {
  return {
    fields: [],
    optionalFields: ['backend'],
    buildTarget: (effect) => {
      const backend = effect.backend;
      const backend_id =
        backend && typeof backend === 'object' && !Array.isArray(backend)
          ? nonEmptyString((backend as Record<string, unknown>).backend_id)
          : nonEmptyString(backend);
      return backend_id ? { operation_id: operationId, backend: backend_id } : undefined;
    },
    reputational_class: 'A',
  };
}

function buildBrowserNavigationTarget(
  operationId: 'browser:goto' | 'browser:open_tab',
  effect: Record<string, unknown>
): unknown {
  if (effect.navigation_confinement !== 'isolated-public-read-v1') return undefined;
  const params = effect.params as { url?: unknown } | undefined;
  if (typeof params?.url !== 'string') return undefined;
  try {
    const url = new URL(params.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return undefined;
    return { operation_id: operationId, origin: url.origin };
  } catch {
    return undefined;
  }
}

/** True when the operation may consult an exact charter grant. The
 * authorization registry is the single source for delegability; this table
 * supplies the effect→target builders. */
export function isDelegableExternalOperation(operationId: string): boolean {
  return operationAuthorization(operationId).delegable !== undefined;
}

/** Effect → raw grant target for the resolver (undefined = not delegable here). */
export function buildExternalOperationTarget(
  operationId: string,
  effect: Record<string, unknown>
): unknown {
  return EXTERNAL_OPERATION_DELEGATION[operationId]?.buildTarget(effect);
}

function normalizeRepositoryUrl(target: string): string | undefined {
  try {
    const url = new URL(target);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return undefined;
    const pathname = url.pathname.replace(/\.git$/, '').replace(/\/$/, '');
    if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pathname)) return undefined;
    return `${url.origin}${pathname}`;
  } catch {
    return undefined;
  }
}

function normalizeOrigin(target: string): string | undefined {
  try {
    const url = new URL(target);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return undefined;
    return url.origin === target ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export function parseExternalOperationGrant(raw: unknown): ExternalOperationGrant | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const op = value.operation_id;
  if (typeof op !== 'string') return undefined;
  const spec = EXTERNAL_OPERATION_DELEGATION[op];
  if (!spec) return undefined;
  const allowed = new Set(['operation_id', ...spec.fields, ...(spec.optionalFields ?? [])]);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key)) || spec.fields.some((f) => !(f in value)))
    return undefined;
  if (
    spec.requiredOneOf &&
    spec.requiredOneOf.filter((field) => typeof value[field] === 'string').length !== 1
  )
    return undefined;
  for (const field of [...spec.fields, ...(spec.optionalFields ?? [])]) {
    const v = value[field];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v !== v.trim()) return undefined;
    if (field !== 'branch_pattern' && v.includes('*')) return undefined;
  }
  // URL/host-shaped fields normalize; literal claim fields (provider, plan,
  // basis, attested_by, tenant_slug, training_use) must match verbatim —
  // the grant is bound to one exact statement, not a family of claims.
  const normalized: Record<string, string | undefined> = {};
  for (const field of [...spec.fields, ...(spec.optionalFields ?? [])]) {
    const raw = value[field] as string | undefined;
    if (raw === undefined) continue;
    if (field === 'visibility' && raw !== 'private') return undefined;
    normalized[field] =
      field === 'repository'
        ? normalizeRepositoryUrl(raw)
        : field === 'branch'
          ? normalizeBranch(raw)
          : field === 'branch_pattern'
            ? normalizeBranchPattern(raw)
            : field === 'origin'
              ? normalizeOrigin(raw)
              : raw;
  }
  if (Object.values(normalized).some((v) => !v)) return undefined;
  if (op === 'tenant:attest_provider' && normalized.training_use !== 'none') return undefined;
  return { operation_id: op, ...normalized } as ExternalOperationGrant;
}

export function parseExternalOperationGrants(raw: unknown): ExternalOperationGrant[] | undefined {
  if (!Array.isArray(raw) || raw.length > 32) return undefined;
  const result = raw.map(parseExternalOperationGrant);
  if (result.some((value) => !value)) return undefined;
  const grants = result as ExternalOperationGrant[];
  if (new Set(grants.map((value) => JSON.stringify(value))).size !== grants.length)
    return undefined;
  return grants;
}

/**
 * Directional coverage: does the signed `grant` cover `target`? Exact fields
 * must equal; a `branch_pattern` grant covers an exact `branch` target under
 * its tree prefix, and covers a narrower `branch_pattern` child whose prefix
 * sits under it (used for parent-charter containment).
 */
export function externalOperationGrantMatches(
  grant: ExternalOperationGrant,
  target: ExternalOperationGrant
): boolean {
  const a = parseExternalOperationGrant(grant);
  const b = parseExternalOperationGrant(target);
  if (!a || !b || a.operation_id !== b.operation_id) return false;
  const targetFields = b as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(a)) {
    if (key === 'operation_id') continue;
    if (key === 'branch_pattern') {
      const prefix = String(value).slice(0, -1);
      const covered =
        typeof targetFields.branch === 'string'
          ? targetFields.branch.startsWith(prefix)
          : typeof targetFields.branch_pattern === 'string' &&
            String(targetFields.branch_pattern).slice(0, -1).startsWith(prefix);
      if (!covered) return false;
      continue;
    }
    if (targetFields[key] !== value) return false;
  }
  return true;
}
