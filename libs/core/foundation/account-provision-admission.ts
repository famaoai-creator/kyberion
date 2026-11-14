/**
 * Internal exact-account write window. The authenticated introduction facade is
 * the sole issuer, after owner, human approval, generation and durable claim
 * checks. tests/account-provision-admission-boundary.test.ts seals that import
 * boundary. This module is deliberately absent from package and root exports.
 * Like the other foundation I/O capabilities, it supplies no roles or grants.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface AccountProvisionInput {
  brokerId: string;
  reference: {
    serviceId: string;
    bindingId: string;
    ownerKind: 'person' | 'organization';
    ownerRef: string;
    tenantSlug?: string;
    generation: string;
  };
  expectedGeneration: string | null;
  material: Record<string, string>;
}
type Window = { input: AccountProvisionInput; requests: WeakSet<object> };
const storage = new AsyncLocalStorage<Window>();
const live = new WeakSet<Window>();
const denied = () => new Error('[ACCOUNT_BROKER_UNAVAILABLE] Account provisioning unavailable');

/** Internal issuer: only account-introduction.ts may enter after its full approved apply checks. */
export async function withAccountProvisionAdmission<T>(
  input: AccountProvisionInput,
  run: () => Promise<T>
): Promise<T> {
  const window = { input, requests: new WeakSet<object>() };
  live.add(window);
  try {
    return await storage.run(window, run);
  } finally {
    live.delete(window);
  }
}
export function assertAccountIntroductionProvisioning(input: AccountProvisionInput): void {
  const window = storage.getStore();
  if (!window || !live.has(window) || window.input !== input) throw denied();
}
/** Broker-only sub-window; cannot be opened without the exact active facade admission. */
export async function withAccountProvisionRequest<T>(
  input: AccountProvisionInput,
  request: object,
  run: () => Promise<T>
): Promise<T> {
  assertAccountIntroductionProvisioning(input);
  const window = storage.getStore()!;
  window.requests.add(request);
  try {
    return await run();
  } finally {
    window.requests.delete(request);
  }
}
export function assertAccountProvisionRequest(request: object): void {
  const window = storage.getStore();
  if (!window || !live.has(window) || !window.requests.has(request)) throw denied();
}
