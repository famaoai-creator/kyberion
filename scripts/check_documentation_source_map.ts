import { loadDocumentationSourceMapAtPath } from '@agent/core/documentation-source-map';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export const DOCUMENTATION_SOURCE_MAP = 'docs/documentation-source-map.json';

const EXPECTED_CANONICALS: Record<string, string> = {
  status: 'docs/developer/improvement-plans-2026-08/README.ja.md',
  concept: 'knowledge/product/architecture/organization-work-loop.md',
  onboarding: 'docs/QUICKSTART.md',
};

const REQUIRED_CATEGORY_IDS = ['status', 'concept', 'onboarding'] as const;

type SourceCategory = {
  id?: unknown;
  canonical?: unknown;
  index?: unknown;
  supporting?: unknown;
  historical?: unknown;
  scoped_sources?: unknown;
};

type SourceMap = {
  manifest_version?: unknown;
  categories?: unknown;
  entrypoints?: unknown;
};

function isRepoRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.startsWith('\\') &&
    !value.split('/').includes('..') &&
    !value.includes('\\')
  );
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null;
  return value as string[];
}

function collectReferencedPaths(category: SourceCategory): string[] {
  const paths: string[] = [];
  for (const key of ['canonical', 'index'] as const) {
    if (typeof category[key] === 'string') paths.push(category[key] as string);
  }
  for (const key of ['supporting', 'historical'] as const) {
    const values = asStringArray(category[key]);
    if (values) paths.push(...values);
  }
  if (Array.isArray(category.scoped_sources)) {
    for (const source of category.scoped_sources) {
      if (source && typeof source === 'object' && 'path' in source) {
        const path = (source as { path?: unknown }).path;
        if (typeof path === 'string') paths.push(path);
      }
    }
  }
  return paths;
}

export function validateDocumentationSourceMap(
  manifest: SourceMap,
  existingPaths: ReadonlySet<string>
): string[] {
  const failures: string[] = [];
  if (manifest.manifest_version !== 1) {
    failures.push('manifest_version must be 1');
  }

  const categories = Array.isArray(manifest.categories)
    ? (manifest.categories as SourceCategory[])
    : null;
  if (!categories) return [...failures, 'categories must be an array'];

  const byId = new Map<string, SourceCategory>();
  for (const category of categories) {
    const id = typeof category?.id === 'string' ? category.id : '';
    if (!id) {
      failures.push('every category requires a non-empty id');
      continue;
    }
    if (byId.has(id)) failures.push(`duplicate category id: ${id}`);
    byId.set(id, category);
    const canonical = category.canonical;
    if (!isRepoRelativePath(canonical)) {
      failures.push(`${id}: canonical must be a repo-relative path`);
    } else if (EXPECTED_CANONICALS[id] && canonical !== EXPECTED_CANONICALS[id]) {
      failures.push(`${id}: canonical must be ${EXPECTED_CANONICALS[id]}`);
    }

    const supporting = asStringArray(category.supporting);
    if (category.supporting !== undefined && supporting === null) {
      failures.push(`${id}: supporting must be an array of paths`);
    }
    const historical = asStringArray(category.historical);
    if (category.historical !== undefined && historical === null) {
      failures.push(`${id}: historical must be an array of paths`);
    }

    if (id === 'onboarding') {
      if (!Array.isArray(category.scoped_sources) || category.scoped_sources.length === 0) {
        failures.push('onboarding: scoped_sources must be a non-empty array');
      } else {
        const scopes = new Set<string>();
        let canonicalScopePresent = false;
        for (const source of category.scoped_sources) {
          if (!source || typeof source !== 'object') {
            failures.push('onboarding: every scoped source must be an object');
            continue;
          }
          const scope = (source as { scope?: unknown }).scope;
          const sourcePath = (source as { path?: unknown }).path;
          if (typeof scope !== 'string' || !scope.trim()) {
            failures.push('onboarding: every scoped source requires a scope');
          } else if (scopes.has(scope)) {
            failures.push(`onboarding: duplicate scope ${scope}`);
          } else {
            scopes.add(scope);
          }
          if (!isRepoRelativePath(sourcePath)) {
            failures.push('onboarding: every scoped source requires a repo-relative path');
          }
          if (sourcePath === category.canonical) canonicalScopePresent = true;
        }
        if (!canonicalScopePresent) {
          failures.push('onboarding: canonical path must be represented in scoped_sources');
        }
      }
    }

    for (const path of collectReferencedPaths(category)) {
      if (!isRepoRelativePath(path)) {
        failures.push(`${id}: referenced path must be repo-relative: ${String(path)}`);
      } else if (!existingPaths.has(path)) {
        failures.push(`${id}: referenced path does not exist: ${path}`);
      }
    }
  }

  for (const id of REQUIRED_CATEGORY_IDS) {
    if (!byId.has(id)) failures.push(`missing required category: ${id}`);
  }

  const entrypoints = asStringArray(manifest.entrypoints);
  if (!entrypoints || entrypoints.length === 0) {
    failures.push('entrypoints must be a non-empty array of paths');
  } else {
    for (const entrypoint of entrypoints) {
      if (!isRepoRelativePath(entrypoint)) {
        failures.push(`entrypoint must be repo-relative: ${entrypoint}`);
      } else if (!existingPaths.has(entrypoint)) {
        failures.push(`entrypoint does not exist: ${entrypoint}`);
      }
    }
  }

  return failures;
}

function read(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) || '');
}

export function checkDocumentationSourceMap(): string[] {
  const mapPath = pathResolver.rootResolve(DOCUMENTATION_SOURCE_MAP);
  if (!safeExistsSync(mapPath)) return [`missing ${DOCUMENTATION_SOURCE_MAP}`];

  let manifest: SourceMap;
  try {
    manifest = loadDocumentationSourceMapAtPath(mapPath);
  } catch (error) {
    return [`${DOCUMENTATION_SOURCE_MAP}: invalid catalog (${String(error)})`];
  }

  const pathCandidates = new Set<string>();
  const addExisting = (relativePath: string) => {
    if (safeExistsSync(pathResolver.rootResolve(relativePath))) pathCandidates.add(relativePath);
  };
  for (const category of Array.isArray(manifest.categories)
    ? (manifest.categories as SourceCategory[])
    : []) {
    for (const path of collectReferencedPaths(category)) addExisting(path);
  }
  for (const entrypoint of asStringArray(manifest.entrypoints) || []) addExisting(entrypoint);

  const failures = validateDocumentationSourceMap(manifest, pathCandidates);
  const sourceMapReference = `documentation-source-map.json`;
  for (const entrypoint of asStringArray(manifest.entrypoints) || []) {
    if (isRepoRelativePath(entrypoint) && !read(entrypoint).includes(sourceMapReference)) {
      failures.push(`${entrypoint}: must link to ${DOCUMENTATION_SOURCE_MAP}`);
    }
  }
  return failures;
}

export const runCheckDocumentationSourceMap = defineScript({
  name: 'check:documentation-source-map',
  run(context) {
    const failures = checkDocumentationSourceMap();
    if (failures.length > 0) {
      throw new ScriptExitError(
        1,
        ['violations detected:', ...failures.map((failure) => `- ${failure}`)].join('\n')
      );
    }
    context.print('[check:documentation-source-map] OK (3 categories)');
    return { failures };
  },
});

if (
  isDirectScript(import.meta.url, 'check_documentation_source_map.ts') ||
  isDirectScript(import.meta.url, 'check_documentation_source_map.js')
)
  void runCheckDocumentationSourceMap();
