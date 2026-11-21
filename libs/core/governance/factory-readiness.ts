import { isValidTenantSlug } from '../entity-scope.js';
import { evaluateAutonomousOpsAction, type AutonomousOpsDecision } from './autonomous-ops-gate.js';
import {
  FACTORY_GRADUATABLE_ACTIONS,
  getFactoryAutonomyPolicy,
  getTenantFactoryAutonomyConfig,
  isFactoryActionGraduated,
  type FactoryAutonomyPolicy,
  type FactoryGraduatableActionId,
} from './factory-policy.js';
import { loadMandateCatalog, type MandateCatalog } from './mandate-shadow.js';
import { getOperationsHaltState } from './operations-halt.js';

export interface FactoryActionReadiness {
  action_id: FactoryGraduatableActionId;
  graduated: boolean;
  decision: AutonomousOpsDecision;
  allowed: boolean;
  shadow: boolean;
  reason: string;
}

export interface FactoryReadinessInput {
  tenant_slug?: string;
  factory_policy?: FactoryAutonomyPolicy;
  mandate_catalog?: MandateCatalog;
  halt_file_path?: string;
  now?: Date;
}

export interface FactoryReadinessReport {
  ready: boolean;
  tenant_slug?: string;
  halted: boolean;
  halt_reason?: string;
  tenant_enabled: boolean;
  graduated_actions: FactoryGraduatableActionId[];
  active_mandate_count: number;
  actions: FactoryActionReadiness[];
  blockers: string[];
}

export function evaluateFactoryReadiness(
  input: FactoryReadinessInput = {}
): FactoryReadinessReport {
  const nowMs = (input.now ?? new Date()).getTime();
  const blockers: string[] = [];

  const haltState = getOperationsHaltState(
    input.halt_file_path ? { rootDir: input.halt_file_path } : {}
  );
  if (haltState.halted) {
    blockers.push(`Operations are halted${haltState.reason ? `: ${haltState.reason}` : ''}`);
  }

  const tenantSlug = input.tenant_slug;
  const validTenant = Boolean(tenantSlug && isValidTenantSlug(tenantSlug));
  if (!tenantSlug) {
    blockers.push('tenant_slug is required to evaluate opt-in factory autonomy readiness');
  } else if (!validTenant) {
    blockers.push(`Invalid tenant_slug '${tenantSlug}'`);
  }

  let factoryPolicy: FactoryAutonomyPolicy | undefined = input.factory_policy;
  if (!factoryPolicy) {
    try {
      factoryPolicy = getFactoryAutonomyPolicy();
    } catch (error) {
      blockers.push(
        `Factory autonomy policy is unreadable (${error instanceof Error ? error.message : String(error)})`
      );
    }
  }

  const tenantConfig =
    validTenant && factoryPolicy
      ? getTenantFactoryAutonomyConfig(tenantSlug, factoryPolicy)
      : undefined;
  const tenantEnabled = tenantConfig?.enabled === true;

  if (validTenant) {
    if (!tenantConfig) {
      blockers.push(`Tenant '${tenantSlug}' is not opted in under factory-autonomy-policy`);
    } else if (!tenantEnabled) {
      blockers.push(`Tenant '${tenantSlug}' factory autonomy is disabled`);
    }
  }

  const graduatedActions = tenantEnabled
    ? FACTORY_GRADUATABLE_ACTIONS.filter((actionId) =>
        isFactoryActionGraduated(actionId, tenantSlug, factoryPolicy)
      )
    : [];

  if (tenantEnabled && graduatedActions.length === 0) {
    blockers.push(`Tenant '${tenantSlug}' has no graduated factory actions configured`);
  }

  let activeMandateCount = 0;
  try {
    const catalog = input.mandate_catalog ?? loadMandateCatalog({ tenantOverlays: validTenant });
    activeMandateCount = catalog.mandates.filter((mandate) => {
      if (Date.parse(mandate.expires_at) <= nowMs) return false;
      if (!mandate.authority) return true;
      return (
        mandate.authority.status === 'active' &&
        (!validTenant || mandate.authority.tenant_slug === tenantSlug)
      );
    }).length;
    if (activeMandateCount === 0) {
      blockers.push('No active non-expired standing mandates are available');
    }
  } catch (error) {
    blockers.push(
      `Standing mandate catalog unavailable (${error instanceof Error ? error.message : String(error)})`
    );
  }

  const actions: FactoryActionReadiness[] = FACTORY_GRADUATABLE_ACTIONS.map((actionId) => {
    const gate = evaluateAutonomousOpsAction({
      actionId,
      tenantSlug: validTenant ? tenantSlug : undefined,
      executionMode: 'apply',
      factoryPolicy,
    });
    return {
      action_id: actionId,
      graduated: validTenant
        ? isFactoryActionGraduated(actionId, tenantSlug, factoryPolicy)
        : false,
      decision: gate.decision,
      allowed: gate.allowed,
      shadow: gate.shadow,
      reason: gate.reason,
    };
  });

  return {
    ready: blockers.length === 0,
    ...(tenantSlug !== undefined ? { tenant_slug: tenantSlug } : {}),
    halted: haltState.halted,
    ...(haltState.reason !== undefined ? { halt_reason: haltState.reason } : {}),
    tenant_enabled: tenantEnabled,
    graduated_actions: graduatedActions,
    active_mandate_count: activeMandateCount,
    actions,
    blockers,
  };
}
