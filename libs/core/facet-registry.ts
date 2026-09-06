import * as path from 'node:path';

import { isValidTenantSlug } from './entity-scope.js';
import { pathResolver } from './path-resolver.js';
import { readTextFile } from './foundation/text.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';
import { isManagedPluginActivationAllowed, listManagedPlugins } from './plugin-managed-install.js';
import { type ResourceProvenance, type ResourceTrust } from './resource-provenance.js';

export type FacetKind = 'persona' | 'policy' | 'instruction' | 'output-contract';
export type FacetTier = 'personal' | 'confidential' | 'public';

export interface FacetScope {
  tier: FacetTier;
  tenantSlug?: string;
  /** Test seam and controlled runtime override for the managed pack root. */
  managedRoot?: string;
}

export interface PluginFacetContribution {
  name: string;
  metadata: Record<string, unknown>;
  provenance: {
    pluginId: string;
    sourcePath: string;
    trust: 'official' | 'third-party';
  };
}

export interface FacetRequest {
  persona?: string;
  policies?: string[];
  instructions?: string[];
  output_contract?: string;
}

export interface ResolvedFacet {
  kind: FacetKind;
  name: string;
  source: 'tenant' | 'product' | 'managed' | 'plugin' | 'legacy' | 'builtin';
  path?: string;
  content: string;
  frontmatter: Record<string, string | string[] | number | boolean>;
  provenance: ResourceProvenance;
}

export interface ResolvedFacets {
  persona?: ResolvedFacet;
  policies: ResolvedFacet[];
  instructions: ResolvedFacet[];
  output_contract?: ResolvedFacet;
}

const FACET_DIRS: Record<FacetKind, string> = {
  persona: 'personas',
  policy: 'policies',
  instruction: 'instructions',
  'output-contract': 'output-contracts',
};

const BUILTIN_FACETS: Record<string, string> = {
  'persona:default':
    'Act as a governed Kyberion worker. Keep scope, authority, and evidence explicit.',
  'instruction:default': 'Follow the declared task contract and report evidence, gaps, and needs.',
  'policy:default':
    'Fail closed on missing scope, invalid contracts, and unapproved external effects.',
  'output-contract:default': 'Return a concise result with outcome, evidence, and unresolved gaps.',
};

const pluginFacetContributions = new Map<string, PluginFacetContribution>();

function assertFacetName(name: string): string {
  const normalized = name.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(normalized)) {
    throw new Error(`[FACET_INVALID_NAME] invalid facet name: ${name}`);
  }
  return normalized;
}

/** Register a virtual facet from an already-authorized plugin activation. */
export function registerPluginFacet(contribution: PluginFacetContribution): () => void {
  const name = assertFacetName(contribution.name);
  if (!contribution.provenance.pluginId.trim()) {
    throw new Error('[FACET_PLUGIN_INVALID] pluginId is required');
  }
  const key = `${contribution.provenance.pluginId}:${name}`;
  if (pluginFacetContributions.has(key)) {
    throw new Error(`[FACET_PLUGIN_DUPLICATE] ${key}`);
  }
  const normalized = { ...contribution, name };
  pluginFacetContributions.set(key, normalized);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (pluginFacetContributions.get(key) === normalized) pluginFacetContributions.delete(key);
  };
}

export function listPluginFacetContributions(): PluginFacetContribution[] {
  return [...pluginFacetContributions.values()].sort((left, right) =>
    `${left.provenance.pluginId}:${left.name}`.localeCompare(
      `${right.provenance.pluginId}:${right.name}`
    )
  );
}

function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string | string[] | number | boolean>;
  content: string;
} {
  if (!raw.startsWith('---\n')) return { frontmatter: {}, content: raw };
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return { frontmatter: {}, content: raw };
  const frontmatter: Record<string, string | string[] | number | boolean> = {};
  for (const line of raw.slice(4, end).split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key || !value) continue;
    if (value.startsWith('[') && value.endsWith(']')) {
      frontmatter[key] = value
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    } else if (value === 'true' || value === 'false') {
      frontmatter[key] = value === 'true';
    } else if (/^-?\d+(\.\d+)?$/.test(value)) {
      frontmatter[key] = Number(value);
    } else {
      frontmatter[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }
  return { frontmatter, content: raw.slice(end + 4).replace(/^\n/, '') };
}

function facetPath(kind: FacetKind, name: string, root: string): string {
  return path.join(root, 'facets', FACET_DIRS[kind], `${name}.md`);
}

function managedFacetPath(
  kind: FacetKind,
  name: string,
  managedRoot?: string
): {
  pluginId: string;
  filePath: string;
} | null {
  const entries = listManagedPlugins(managedRoot).filter((entry) =>
    isManagedPluginActivationAllowed(entry)
  );
  for (const entry of entries) {
    const declaration = entry.manifest?.raw?.facets;
    const declared: Array<{ kind: FacetKind; name: string; path?: string }> = [];
    if (declaration && typeof declaration === 'object' && !Array.isArray(declaration)) {
      for (const [rawKind, rawNames] of Object.entries(declaration as Record<string, unknown>)) {
        if (!(rawKind in FACET_DIRS) || !Array.isArray(rawNames)) continue;
        for (const rawName of rawNames) {
          if (typeof rawName === 'string')
            declared.push({ kind: rawKind as FacetKind, name: rawName });
        }
      }
    } else if (Array.isArray(declaration)) {
      for (const item of declaration) {
        if (!item || typeof item !== 'object') continue;
        const candidate = item as Record<string, unknown>;
        if (
          typeof candidate.kind === 'string' &&
          candidate.kind in FACET_DIRS &&
          typeof candidate.name === 'string'
        ) {
          declared.push({
            kind: candidate.kind as FacetKind,
            name: candidate.name,
            ...(typeof candidate.path === 'string' ? { path: candidate.path } : {}),
          });
        }
      }
    }
    const match = declared.find((candidate) => candidate.kind === kind && candidate.name === name);
    if (!match) continue;
    const relative = match.path || path.join('facets', FACET_DIRS[kind], `${name}.md`);
    if (path.isAbsolute(relative) || relative.includes('..')) {
      throw new Error(
        `[FACET_PACK_INVALID] managed facet path escapes the pack: ${entry.pluginId}`
      );
    }
    const root = path.resolve(entry.managedPath);
    const filePath = path.resolve(root, relative);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      throw new Error(
        `[FACET_PACK_INVALID] managed facet path escapes the pack: ${entry.pluginId}`
      );
    }
    if (safeExistsSync(filePath)) return { pluginId: entry.pluginId, filePath };
  }
  return null;
}

function readFacet(
  kind: FacetKind,
  name: string,
  source: ResolvedFacet['source'],
  filePath: string,
  pluginId?: string
): ResolvedFacet {
  const safeFilePath = assertSafeRepositoryPath(filePath);
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[FACET_RESOURCE] facet must be a regular file: ${safeFilePath}`);
  }
  const parsed = parseFrontmatter(readTextFile(safeFilePath));
  return {
    kind,
    name,
    source,
    path: safeFilePath,
    content: parsed.content,
    frontmatter: parsed.frontmatter,
    provenance: facetProvenance(source, safeFilePath, pluginId),
  };
}

function facetProvenance(
  source: ResolvedFacet['source'],
  filePath: string,
  pluginId?: string
): ResourceProvenance {
  const isTenant = source === 'tenant';
  const isPlugin = source === 'managed' || source === 'plugin';
  const trust: ResourceTrust = isPlugin ? 'approved' : isTenant ? 'trusted' : 'trusted';
  return {
    source: 'facet-registry',
    scope: isTenant ? 'tenant' : 'repository',
    origin: isTenant ? 'tenant-overlay' : isPlugin ? 'plugin' : 'builtin',
    base_dir: path.dirname(filePath),
    trust,
    ...(pluginId ? { plugin_id: pluginId } : {}),
  };
}

function resolvePluginFacet(kind: FacetKind, name: string): ResolvedFacet | undefined {
  const matches = listPluginFacetContributions().filter(
    (entry) =>
      entry.name === name &&
      entry.metadata.kind === kind &&
      typeof entry.metadata.content === 'string'
  );
  if (matches.length > 1) {
    throw new Error(
      `[FACET_AMBIGUOUS] ${kind}:${name} is provided by multiple plugins: ${matches
        .map((entry) => entry.provenance.pluginId)
        .join(', ')}`
    );
  }
  const entry = matches[0];
  if (!entry) return undefined;
  const sourcePath = entry.provenance.sourcePath;
  const frontmatter =
    entry.metadata.frontmatter && typeof entry.metadata.frontmatter === 'object'
      ? (entry.metadata.frontmatter as ResolvedFacet['frontmatter'])
      : { kind };
  return {
    kind,
    name,
    source: 'plugin',
    ...(typeof entry.metadata.path === 'string' ? { path: entry.metadata.path } : {}),
    content: entry.metadata.content as string,
    frontmatter,
    provenance: {
      source: 'facet-registry',
      scope: 'repository',
      origin: 'plugin',
      base_dir: path.dirname(sourcePath),
      trust: entry.provenance.trust,
      plugin_id: entry.provenance.pluginId,
    },
  };
}

function resolveOne(kind: FacetKind, requestedName: string, scope: FacetScope): ResolvedFacet {
  const name = assertFacetName(requestedName);
  if (scope.tenantSlug !== undefined && !isValidTenantSlug(scope.tenantSlug)) {
    throw new Error(`[FACET_SCOPE_INVALID] invalid tenant slug: ${scope.tenantSlug}`);
  }
  if (scope.tier === 'public' && scope.tenantSlug) {
    throw new Error(
      '[FACET_TIER_DENIED] public pipelines cannot resolve confidential tenant facets'
    );
  }
  const plugin = resolvePluginFacet(kind, name);
  if (plugin) return plugin;
  if (scope.tenantSlug && scope.tier !== 'public') {
    const tenantPath = facetPath(
      kind,
      name,
      pathResolver.knowledge(`confidential/${scope.tenantSlug}`)
    );
    if (safeExistsSync(tenantPath)) return readFacet(kind, name, 'tenant', tenantPath);
  }
  const productPath = facetPath(kind, name, pathResolver.knowledge('product'));
  if (safeExistsSync(productPath)) return readFacet(kind, name, 'product', productPath);

  const managed = managedFacetPath(kind, name, scope.managedRoot);
  if (managed) return readFacet(kind, name, 'managed', managed.filePath, managed.pluginId);

  // Existing role procedures remain a compatibility layer until every role has
  // a persona facet. They are still product-scoped and never tenant-scoped.
  if (kind === 'persona') {
    const legacyPath = pathResolver.knowledge(`product/roles/${name}/PROCEDURE.md`);
    if (safeExistsSync(legacyPath)) return readFacet(kind, name, 'legacy', legacyPath);
  }
  const builtin = BUILTIN_FACETS[`${kind}:${name}`];
  if (!builtin) throw new Error(`[FACET_NOT_FOUND] ${kind}:${name} is not registered`);
  return {
    kind,
    name,
    source: 'builtin',
    content: builtin,
    frontmatter: { kind, purity: 'clean' },
    provenance: {
      source: 'facet-registry',
      scope: 'repository',
      origin: 'builtin',
      base_dir: pathResolver.knowledge('product'),
      trust: 'trusted',
    },
  };
}

export function resolveFacets(request: FacetRequest = {}, scope: FacetScope): ResolvedFacets {
  return {
    ...(request.persona ? { persona: resolveOne('persona', request.persona, scope) } : {}),
    policies: (request.policies || []).map((name) => resolveOne('policy', name, scope)),
    instructions: (request.instructions || []).map((name) =>
      resolveOne('instruction', name, scope)
    ),
    ...(request.output_contract
      ? { output_contract: resolveOne('output-contract', request.output_contract, scope) }
      : {}),
  };
}

export function renderFacets(facets: ResolvedFacets): string {
  const sections: string[] = [];
  if (facets.persona)
    sections.push(`## Persona facet: ${facets.persona.name}\n${facets.persona.content}`);
  for (const facet of facets.policies)
    sections.push(`## Policy facet: ${facet.name}\n${facet.content}`);
  for (const facet of facets.instructions)
    sections.push(`## Instruction facet: ${facet.name}\n${facet.content}`);
  if (facets.output_contract) {
    sections.push(
      `## Output contract facet: ${facets.output_contract.name}\n${facets.output_contract.content}`
    );
  }
  return sections.join('\n\n');
}

export function validateFacetPurity(facet: Pick<ResolvedFacet, 'kind' | 'content'>): string[] {
  const text = facet.content.toLowerCase();
  const errors: string[] = [];
  if (facet.kind === 'persona' && /standard procedures|step-by-step|procedure:/.test(text)) {
    errors.push('persona facet contains procedural instructions');
  }
  if (facet.kind === 'policy' && /output contract|response format|schema_ref/.test(text)) {
    errors.push('policy facet contains output-format instructions');
  }
  return errors;
}
