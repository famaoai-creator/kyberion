/** Narrow policy ports: registration checks return no private profile data. */
let membership: ((tenant: string, rootDir?: string) => boolean) | undefined;
let alertStore: (<T>(fn: () => T) => T) | undefined;
export function registerOperationalTenantMembership(
  reader: (tenant: string, rootDir?: string) => boolean
): void {
  if (membership && membership !== reader)
    throw new Error('[OPERATIONAL_POLICY_DUPLICATE] tenant membership already registered');
  membership = reader;
}
export function isRegisteredOperationalTenant(tenant: string, rootDir?: string): boolean {
  const reader = membership;
  if (!reader)
    throw new Error(
      '[TENANT_MEMBERSHIP_POLICY_UNAVAILABLE] initialize the governed authority runtime'
    );
  return reader(tenant, rootDir);
}
export function registerOperationalAlertStore(context: <T>(fn: () => T) => T): void {
  if (alertStore && alertStore !== context)
    throw new Error('[OPERATIONAL_POLICY_DUPLICATE] alert store already registered');
  alertStore = context;
}
export function withOperationalAlertStore<T>(fn: () => T): T {
  const context = alertStore;
  if (!context) return fn();
  return context(fn);
}
