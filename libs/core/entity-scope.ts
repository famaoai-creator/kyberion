/** Canonical entity scope hierarchy for storage, authorization, and lineage. */
export const ENTITY_SCOPE_HIERARCHY = [
  'tenant_slug',
  'organization_id',
  'project_id',
  'mission_id',
  'task_id',
  'session',
] as const;

export type EntityScopeKey = (typeof ENTITY_SCOPE_HIERARCHY)[number];
