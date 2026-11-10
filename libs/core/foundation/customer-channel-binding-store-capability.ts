/**
 * Narrow, tenant-bound store grant (S4; formerly a role) writing of one tenant's customer channel bindings
 * (`knowledge/confidential/<tenant>/connections/channel-bindings.json`, D8,
 * scripts/customer-channel/bindings.ts `writeBindingChange`). Its policy grant
 * is the bound tenant's `knowledge/confidential/<tenant>/connections/` directory; the tier
 * guard narrows every write and mkdir to the role's `narrow` declaration in
 * security-policy.json
 * (store_grants.customer_channel_binding_store.narrow, G3; S4: an explicit deny
 * declaration on the declared store grant the binding facade opens): the
 * bindings file and the directories leading to it. No other tenant
 * file (connection secrets, overlays), no knowledge or runtime state. It
 * replaces the broad `customer_create` role on that write.
 */
export const CUSTOMER_CHANNEL_BINDING_STORE_ROLE = 'customer_channel_binding_store';
