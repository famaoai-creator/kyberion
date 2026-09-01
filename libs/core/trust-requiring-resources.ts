/**
 * Resources whose project/tenant-local contents can change executable or
 * model-visible behaviour and therefore require trust resolution first.
 *
 * This is a vocabulary contract, not an authorization decision by itself.
 * The caller still applies the viewer, tenant, plugin provenance, and human
 * approval policies appropriate to its surface.
 */
export const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = [
  '.kyberion-plugins.json',
  'pipelines/',
  'roles/PROCEDURE.md',
  'facets/',
  'AGENTS.override.md',
  'skills/',
] as const;

/**
 * Repository-owned pipeline entrypoints are part of the executable product,
 * not project-local configuration. They are needed by the session gate and
 * other built-in commands before an operator has made a project-trust
 * decision. A nested run still inherits its parent's trust signal, so callers
 * cannot use this classification to widen an unresolved execution.
 */
export const BUILTIN_PIPELINE_RESOURCE_PREFIXES = [
  'pipelines/',
  'knowledge/product/pipeline-templates/',
] as const;

export type TrustRequiringProjectConfigResource =
  (typeof TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES)[number];

function normalizeResourcePath(resourcePath: string): string {
  return resourcePath.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+/gu, '/');
}

export function isBuiltinPipelineResource(resourcePath: string): boolean {
  const normalized = normalizeResourcePath(resourcePath);
  return BUILTIN_PIPELINE_RESOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Return the matching trust-sensitive resource declaration, if any. */
export function classifyTrustRequiringResource(
  resourcePath: string
): TrustRequiringProjectConfigResource | undefined {
  const normalized = normalizeResourcePath(resourcePath).replace(/\/$/u, '');
  return TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES.find((resource) => {
    const candidate = resource.replace(/\/$/u, '');
    return normalized === candidate || normalized.startsWith(`${candidate}/`);
  });
}

/** A resource is safe to inspect before trust resolution only when it is not in this set. */
export function requiresProjectTrust(resourcePath: string): boolean {
  return classifyTrustRequiringResource(resourcePath) !== undefined;
}
