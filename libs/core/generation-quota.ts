import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import { isValidTenantSlug } from './entity-scope.js';
import { normalizeEventScope, type EventScope, type EventScopeInput } from './event-scope.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { withLockSync } from './src/lock-utils.js';

export const GENERATION_QUOTA_POLICY_REPO_PATH =
  'knowledge/product/governance/media-generation-quota-policy.json';
export const GENERATION_QUOTA_COUNTER_REPO_SUBPATH = 'active/shared/runtime/media-generation/quota';

export interface GenerationQuotaOverride {
  max_units_per_day?: number;
  warn_ratio?: number;
  operation_units?: Record<string, number>;
}

export interface GenerationQuotaPolicy {
  max_units_per_day: number;
  warn_ratio: number;
  operation_units: Record<string, number>;
  tenant_overrides?: Record<string, GenerationQuotaOverride>;
}

export const DEFAULT_GENERATION_QUOTA_POLICY: GenerationQuotaPolicy = Object.freeze({
  max_units_per_day: 100,
  warn_ratio: 0.8,
  operation_units: {
    generate_image: 1,
    generate_video: 10,
    generate_music: 10,
    run_workflow: 5,
  },
  tenant_overrides: {},
});

export type GenerationQuotaLevel = 'ok' | 'warn' | 'block';

export interface GenerationQuotaUsage {
  units: number;
}

interface ReadGenerationQuotaUsage {
  usage: GenerationQuotaUsage;
  invalid: boolean;
}

export interface GenerationQuotaOptions {
  rootDir?: string;
  now?: string | Date;
  policy?: GenerationQuotaPolicy;
  /** Exact units reserved earlier; used when releasing after a policy change. */
  reservation_units?: number;
}

export interface GenerationQuotaDecision {
  allowed: boolean;
  level: GenerationQuotaLevel;
  tenant_slug?: string;
  date?: string;
  action: string;
  units: number;
  usage: GenerationQuotaUsage;
  projected: GenerationQuotaUsage;
  limit?: number;
  warned: boolean;
  reason?: string;
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function rootDir(options: GenerationQuotaOptions): string {
  return options.rootDir ?? pathResolver.rootDir();
}

export function generationQuotaDateKey(now?: string | Date): string {
  const date = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`[generation-quota] invalid now '${String(now)}'`);
  }
  return date.toISOString().slice(0, 10);
}

export function generationQuotaCounterPath(
  tenantSlug: string,
  options: GenerationQuotaOptions = {}
): string {
  if (!isValidTenantSlug(tenantSlug)) {
    throw new Error(`[generation-quota] invalid tenant slug '${tenantSlug}'`);
  }
  return path.join(
    rootDir(options),
    ...GENERATION_QUOTA_COUNTER_REPO_SUBPATH.split('/'),
    tenantSlug,
    `${generationQuotaDateKey(options.now)}.json`
  );
}

function readPolicy(options: GenerationQuotaOptions): GenerationQuotaPolicy {
  const policyPath = path.join(rootDir(options), ...GENERATION_QUOTA_POLICY_REPO_PATH.split('/'));
  if (!safeExistsSync(policyPath)) return { ...DEFAULT_GENERATION_QUOTA_POLICY };
  try {
    const parsed = JSON.parse(String(safeReadFile(policyPath, { encoding: 'utf8' }) || '{}')) as {
      max_units_per_day?: unknown;
      warn_ratio?: unknown;
      operation_units?: unknown;
      tenant_overrides?: unknown;
    };
    const operationUnits = Object.fromEntries(
      Object.entries(parsed.operation_units ?? {}).filter(([, value]) => positive(value))
    ) as Record<string, number>;
    const tenantOverrides: Record<string, GenerationQuotaOverride> = {};
    if (parsed.tenant_overrides && typeof parsed.tenant_overrides === 'object') {
      for (const [tenant, raw] of Object.entries(parsed.tenant_overrides)) {
        if (!raw || typeof raw !== 'object') continue;
        const value = raw as Record<string, unknown>;
        const operationOverride = Object.fromEntries(
          Object.entries(value.operation_units ?? {}).filter(([, unit]) => positive(unit))
        ) as Record<string, number>;
        const override: GenerationQuotaOverride = {
          ...(positive(value.max_units_per_day)
            ? { max_units_per_day: value.max_units_per_day }
            : {}),
          ...(positive(value.warn_ratio) && value.warn_ratio <= 1
            ? { warn_ratio: value.warn_ratio }
            : {}),
          ...(Object.keys(operationOverride).length > 0
            ? { operation_units: operationOverride }
            : {}),
        };
        if (Object.keys(override).length > 0) tenantOverrides[tenant] = override;
      }
    }
    return {
      max_units_per_day: positive(parsed.max_units_per_day)
        ? parsed.max_units_per_day
        : DEFAULT_GENERATION_QUOTA_POLICY.max_units_per_day,
      warn_ratio:
        positive(parsed.warn_ratio) && parsed.warn_ratio <= 1
          ? parsed.warn_ratio
          : DEFAULT_GENERATION_QUOTA_POLICY.warn_ratio,
      operation_units:
        Object.keys(operationUnits).length > 0
          ? operationUnits
          : { ...DEFAULT_GENERATION_QUOTA_POLICY.operation_units },
      ...(Object.keys(tenantOverrides).length > 0
        ? { tenant_overrides: tenantOverrides }
        : { tenant_overrides: {} }),
    };
  } catch {
    return { ...DEFAULT_GENERATION_QUOTA_POLICY };
  }
}

export function loadGenerationQuotaPolicy(
  options: GenerationQuotaOptions = {}
): GenerationQuotaPolicy {
  return options.policy ?? readPolicy(options);
}

function effectivePolicy(policy: GenerationQuotaPolicy, tenantSlug: string, action: string) {
  const override = policy.tenant_overrides?.[tenantSlug];
  return {
    limit: override?.max_units_per_day ?? policy.max_units_per_day,
    warnRatio: override?.warn_ratio ?? policy.warn_ratio,
    units:
      override?.operation_units?.[action] ??
      policy.operation_units[action] ??
      policy.operation_units.run_workflow ??
      DEFAULT_GENERATION_QUOTA_POLICY.operation_units.run_workflow,
  };
}

function readUsage(counterPath: string): ReadGenerationQuotaUsage {
  if (!safeExistsSync(counterPath)) return { usage: { units: 0 }, invalid: false };
  try {
    const parsed = JSON.parse(String(safeReadFile(counterPath, { encoding: 'utf8' }) || '{}')) as {
      units?: unknown;
    };
    if (parsed.units === 0 || positive(parsed.units)) {
      return { usage: { units: parsed.units as number }, invalid: false };
    }
    return { usage: { units: 0 }, invalid: true };
  } catch {
    return { usage: { units: 0 }, invalid: true };
  }
}

function writeUsage(
  counterPath: string,
  tenantSlug: string,
  date: string,
  usage: GenerationQuotaUsage,
  options: GenerationQuotaOptions
): void {
  safeMkdir(path.dirname(counterPath), { recursive: true });
  safeWriteFile(
    counterPath,
    JSON.stringify(
      {
        tenant_slug: tenantSlug,
        date,
        units: usage.units,
        updated_at:
          options.now === undefined
            ? new Date().toISOString()
            : new Date(options.now).toISOString(),
      },
      null,
      2
    )
  );
}

function normalizedTenant(scope: EventScopeInput): { scope: EventScope; tenant?: string } {
  const normalized = normalizeEventScope(scope);
  return { scope: normalized, tenant: normalized.tenant_slug };
}

function decide(
  scope: EventScopeInput,
  action: string,
  options: GenerationQuotaOptions,
  mutate: (input: {
    tenant: string;
    date: string;
    units: number;
    limit: number;
    warnRatio: number;
    counterPath: string;
  }) => GenerationQuotaDecision
): GenerationQuotaDecision {
  const { tenant } = normalizedTenant(scope);
  if (!tenant) {
    return {
      allowed: true,
      level: 'ok',
      action,
      units: 0,
      usage: { units: 0 },
      projected: { units: 0 },
      warned: false,
      reason: 'system scope is not charged to a tenant quota',
    };
  }
  const policy = loadGenerationQuotaPolicy(options);
  const effective = effectivePolicy(policy, tenant, action);
  const date = generationQuotaDateKey(options.now);
  return mutate({
    tenant,
    date,
    units: positive(options.reservation_units) ? options.reservation_units : effective.units,
    limit: effective.limit,
    warnRatio: effective.warnRatio,
    counterPath: generationQuotaCounterPath(tenant, options),
  });
}

/** Read the tenant's current daily generation budget without consuming it. */
export function checkGenerationQuota(
  scope: EventScopeInput,
  action: string,
  options: GenerationQuotaOptions = {}
): GenerationQuotaDecision {
  return decide(
    scope,
    action,
    options,
    ({ tenant, date, units, limit, warnRatio, counterPath }) => {
      const counter = readUsage(counterPath);
      const usage = counter.usage;
      const projected = { units: usage.units + units };
      if (counter.invalid) {
        return {
          allowed: false,
          level: 'block',
          tenant_slug: tenant,
          date,
          action,
          units,
          usage,
          projected,
          limit,
          warned: false,
          reason: `tenant '${tenant}' generation quota counter is invalid`,
        };
      }
      const warned = projected.units >= warnRatio * limit;
      const allowed = projected.units <= limit;
      return {
        allowed,
        level: allowed ? (warned ? 'warn' : 'ok') : 'block',
        tenant_slug: tenant,
        date,
        action,
        units,
        usage,
        projected,
        limit,
        warned,
        ...(allowed
          ? {}
          : { reason: `tenant '${tenant}' daily generation quota would exceed ${limit} units` }),
      };
    }
  );
}

/** Atomically reserve one generation operation before provider submission. */
export function reserveGenerationQuota(
  scope: EventScopeInput,
  action: string,
  options: GenerationQuotaOptions = {}
): GenerationQuotaDecision {
  return decide(scope, action, options, (input) =>
    withLockSync(`generation-quota-${input.tenant}-${input.date}`, () => {
      const counter = readUsage(input.counterPath);
      const usage = counter.usage;
      const projected = { units: usage.units + input.units };
      const warned = projected.units >= input.warnRatio * input.limit;
      const allowed = !counter.invalid && projected.units <= input.limit;
      if (allowed) writeUsage(input.counterPath, input.tenant, input.date, projected, options);
      return {
        allowed,
        level: allowed ? (warned ? 'warn' : 'ok') : 'block',
        tenant_slug: input.tenant,
        date: input.date,
        action,
        units: input.units,
        usage,
        projected,
        limit: input.limit,
        warned,
        ...(allowed
          ? {}
          : {
              reason: counter.invalid
                ? `tenant '${input.tenant}' generation quota counter is invalid`
                : `tenant '${input.tenant}' daily generation quota exceeded`,
            }),
      };
    })
  );
}

/** Refund a reservation when provider submission fails before a job exists. */
export function releaseGenerationQuota(
  scope: EventScopeInput,
  action: string,
  options: GenerationQuotaOptions = {}
): GenerationQuotaDecision {
  return decide(scope, action, options, (input) =>
    withLockSync(`generation-quota-${input.tenant}-${input.date}`, () => {
      const counter = readUsage(input.counterPath);
      const usage = counter.usage;
      if (counter.invalid) {
        return {
          allowed: false,
          level: 'block',
          tenant_slug: input.tenant,
          date: input.date,
          action,
          units: input.units,
          usage,
          projected: usage,
          limit: input.limit,
          warned: false,
          reason: `tenant '${input.tenant}' generation quota counter is invalid`,
        };
      }
      const next = { units: Math.max(0, usage.units - input.units) };
      writeUsage(input.counterPath, input.tenant, input.date, next, options);
      return {
        allowed: true,
        level: 'ok',
        tenant_slug: input.tenant,
        date: input.date,
        action,
        units: input.units,
        usage,
        projected: next,
        limit: input.limit,
        warned: false,
        reason: 'generation quota reservation released',
      };
    })
  );
}
