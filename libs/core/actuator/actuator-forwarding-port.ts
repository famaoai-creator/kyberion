import { AsyncLocalStorage } from 'node:async_hooks';
import type { ContextSecurityScope } from '../governance/context-security-scope.js';
import { coreSeamCatalog, createSeam, createSeamLifecycle } from '../seam.js';

export type ActuatorForwardStatus = 'succeeded' | 'failed' | 'blocked';

export interface ActuatorForwardRequest {
  source_actuator: string;
  requested_op: string;
  target_actuator: string;
  target_op: string;
  params: Record<string, unknown>;
  context: Record<string, unknown>;
  security_scope?: ContextSecurityScope;
  idempotency_key: string;
}

export interface ActuatorForwardReceipt {
  forwarded_to: string;
  status: ActuatorForwardStatus;
  result?: unknown;
  context?: Record<string, unknown>;
  error?: string;
}

export interface ActuatorForwardingPort {
  forward(request: ActuatorForwardRequest): Promise<ActuatorForwardReceipt>;
}

class MissingActuatorForwardingPort implements ActuatorForwardingPort {
  async forward(request: ActuatorForwardRequest): Promise<ActuatorForwardReceipt> {
    throw new Error(
      `[ACTUATOR_FORWARDING_PORT_UNAVAILABLE] ${request.source_actuator}:${request.requested_op} requires ${request.target_actuator}:${request.target_op}`
    );
  }
}

const actuatorForwardingPortSeam = createSeam<ActuatorForwardingPort>({
  key: 'actuator-forwarding-port',
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
  owner: 'libs/core/actuator/actuator-forwarding-port.ts',
});
const actuatorForwardingPortLifecycle = createSeamLifecycle(actuatorForwardingPortSeam);
const forwardingPortStorage = new AsyncLocalStorage<ActuatorForwardingPort>();

export function withActuatorForwardingPort<T>(
  port: ActuatorForwardingPort,
  task: () => Promise<T> | T
): Promise<T> | T {
  return forwardingPortStorage.run(port, task);
}

export function registerActuatorForwardingPort(port: ActuatorForwardingPort): () => void {
  return actuatorForwardingPortLifecycle.register('default', port, {
    provenance: 'builtin',
    source: 'actuator-forwarding-port',
  });
}

export function resetActuatorForwardingPort(): void {
  actuatorForwardingPortLifecycle.reset();
}

export function getActuatorForwardingPort(): ActuatorForwardingPort {
  return (
    forwardingPortStorage.getStore() ||
    actuatorForwardingPortSeam.getOptional() ||
    new MissingActuatorForwardingPort()
  );
}
