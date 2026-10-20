import type { ContextSecurityScope } from '../context-security-scope.js';
import type { DelegatedExecutionTarget } from '../governance/delegated-execution.js';
import type { HumanExecutionReference } from '../governance/human-execution.js';

export interface TenantServiceEngineAdmissionData {
  securityScope: ContextSecurityScope;
  bindingId: string;
  approvalGranted: boolean;
  /** Distinct from human approval; revalidated at the real provider boundary. */
  delegated?: { target: DelegatedExecutionTarget; permitId: string };
  humanExecution?: { target: DelegatedExecutionTarget; reference: HumanExecutionReference };
}

const admissions = new WeakMap<object, TenantServiceEngineAdmissionData>();

/** Issue an opaque, in-process capability for the service-actuator dispatch path. */
export function issueTenantServiceEngineAdmission(data: TenantServiceEngineAdmissionData): object {
  const capability = Object.freeze({});
  admissions.set(capability, data);
  return capability;
}

export function resolveTenantServiceEngineAdmission(
  capability: object
): TenantServiceEngineAdmissionData | undefined {
  return admissions.get(capability);
}
