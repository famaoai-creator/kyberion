import { credentialExecutionIdentity } from '@agent/core/foundation/credential-binding';
import { getRegisteredEnvText } from '@agent/core/foundation';
import {
  authorizeTenantServiceAction,
  type TenantServiceBindingAuthorization,
} from '@agent/core/service/service-binding-registry';
import { getServicePresetRecord } from '@agent/core/service/service-preset-registry';
import {
  validateContextSecurityScope,
  resolveTenantAlias,
  type ContextSecurityScope,
} from '@agent/core/context-security-scope';

type ServiceBindingInput = {
  service_id?: string;
  mode: string;
  action: string;
  context?: Record<string, any>;
};

export function authorizeTenantServiceBinding(input: ServiceBindingInput): {
  bindingId?: string;
  approvalRequired: boolean;
} {
  if (!input.service_id || input.action === 'pipeline') return { approvalRequired: false };
  const preset = getServicePresetRecord(input.service_id);
  const operation = preset?.operations?.[input.action];
  // Discovery and connection administration do not execute a service operation.
  const executesOperation = !['HARNESS', 'OAUTH', 'RECONCILE'].includes(input.mode);
  const identity = credentialExecutionIdentity();
  const raw = input.context?.security_scope;
  const declaredScope = raw && typeof raw === 'object' ? (raw as ContextSecurityScope) : undefined;
  const tenantExecution =
    executesOperation &&
    Boolean(identity.tenantSlug || (declaredScope && resolveTenantAlias(declaredScope)));
  const required =
    tenantExecution ||
    preset?.tenant_binding_required === true ||
    Object.values(preset?.operations || {}).some(
      (candidate: any) => candidate?.tenant_binding_required === true
    );
  if (!required) return { approvalRequired: false };
  if (input.mode !== 'PRESET') {
    throw new Error(
      `[POLICY_VIOLATION] Tenant-bound service '${input.service_id}' must execute declared preset operations through PRESET mode`
    );
  }
  if (!operation) {
    throw new Error(
      `[POLICY_VIOLATION] Service '${input.service_id}' requires a tenant binding and only declared preset operations are allowed`
    );
  }
  if (
    !tenantExecution &&
    preset?.tenant_binding_required !== true &&
    operation.tenant_binding_required !== true
  ) {
    return { approvalRequired: false };
  }

  if (!raw || typeof raw !== 'object') {
    throw new Error('[POLICY_VIOLATION] Tenant service binding requires security_scope');
  }
  const securityScope = raw as ContextSecurityScope;
  const errors = validateContextSecurityScope(securityScope);
  if (errors.length) {
    throw new Error(`[POLICY_VIOLATION] Invalid service security_scope: ${errors.join('; ')}`);
  }
  if (
    !identity.tenantSlug ||
    identity.tenantSlug !== resolveTenantAlias(securityScope) ||
    (identity.missionId && identity.missionId !== securityScope.mission_id) ||
    (identity.taskId && identity.taskId !== securityScope.task_id)
  ) {
    throw new Error('[POLICY_VIOLATION] Service security_scope does not match execution identity');
  }
  const activeMissionId = String(getRegisteredEnvText('MISSION_ID') || '').trim();
  if (!activeMissionId || securityScope.mission_id !== activeMissionId) {
    throw new Error('[POLICY_VIOLATION] Service security_scope is not bound to the active mission');
  }
  if (input.context?.mission_id && input.context.mission_id !== securityScope.mission_id) {
    throw new Error('[POLICY_VIOLATION] Service mission_id conflicts with security_scope');
  }

  const binding: TenantServiceBindingAuthorization = authorizeTenantServiceAction({
    serviceId: input.service_id,
    action: input.action,
    securityScope,
    bindingId: input.context?.service_binding_id,
  });
  return {
    bindingId: binding.bindingId,
    approvalRequired:
      binding.approvalRequired ||
      operation.approval_required === true ||
      operation.risk === 'write' ||
      operation.risk === 'destructive' ||
      (operation.approval_required !== false && operation.risk !== 'read'),
  };
}
