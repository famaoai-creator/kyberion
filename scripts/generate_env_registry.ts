/**
 * generate_env_registry.ts — OP-05: canonical registry of KYBERION_* env vars.
 *
 * Scans the source tree for `KYBERION_[A-Z0-9_]+` references and maintains
 * `knowledge/product/governance/env-registry.json`. Curated fields on existing
 * entries (description, type, enum, required, subsystem, …) are preserved;
 * newly discovered names are added with an auto classification and
 * `documented: false`. Entries whose name is no longer referenced anywhere
 * are dropped.
 *
 * Also generates `docs/developer/env.example` and
 * `docs/developer/CONFIGURATION.md` from the registry so the configuration
 * surface has a single source of truth. (The example lives under docs/
 * because the policy engine deliberately refuses writes to root dotfiles;
 * copy it to `.env` locally.)
 *
 * Usage:
 *   pnpm generate:env-registry          — rewrite the three artifacts
 *   pnpm run check -- --scope full --only env-registry
 *                                      — fail if any artifact drifted
 *   KYBERION_ENV_REGISTRY_STRICT=1 pnpm run check -- --scope full --only env-registry
 *                                      — also fail while entries remain undocumented
 */

import * as path from 'node:path';
import { format as prettierFormat, resolveConfig as resolvePrettierConfig } from 'prettier';
import { pathResolver, safeExistsSync, safeReadFile } from '@agent/core';
import { getRegisteredEnv, readJson } from '@agent/core/foundation';
import { getAllFiles } from '@agent/core/fs-utils';
import { defineGenerator, isDirectScript } from './lib/harness.js';

export type EnvCategory = 'secret' | 'path' | 'flag' | 'tuning' | 'provider' | 'runtime';
export type EnvType = 'string' | 'boolean' | 'number' | 'enum' | 'path';

export interface EnvRegistryEntry {
  name: string;
  category: EnvCategory;
  type: EnvType;
  enum?: string[];
  required: boolean;
  default?: string | null;
  subsystem?: string;
  description: string;
  documented: boolean;
}

export interface EnvRegistryFile {
  $schema?: string;
  version: string;
  description: string;
  entries: EnvRegistryEntry[];
}

export function validateEnvRegistryQuality(registry: EnvRegistryFile): string[] {
  const failures: string[] = [];
  for (const entry of registry.entries) {
    if (entry.required && entry.documented !== true) {
      failures.push(`${entry.name}: required entries must be documented`);
    }
    if ((entry.required || entry.documented) && !entry.description.trim()) {
      failures.push(`${entry.name}: required/documented entries must have a description`);
    }
    if (entry.required && entry.category === 'secret') {
      failures.push(`${entry.name}: secrets may not be required through the shared registry`);
    }
    if (entry.category === 'secret' && entry.default !== undefined && entry.default !== null) {
      failures.push(`${entry.name}: secrets may not define a registry default`);
    }
    if (entry.category === 'secret' && entry.type !== 'string') {
      failures.push(`${entry.name}: secrets must use the opaque string type`);
    }
  }
  return failures;
}

const REGISTRY_PATH = pathResolver.knowledge('product/governance/env-registry.json');
const ENV_EXAMPLE_PATH = pathResolver.rootResolve('docs/developer/env.example');
const CONFIGURATION_DOC_PATH = pathResolver.rootResolve('docs/developer/CONFIGURATION.md');

const SCAN_ROOTS = ['libs', 'scripts', 'satellites', 'presence', 'pipelines', 'tests'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.py']);
const EXCLUDED_PATH_SEGMENTS = [
  '/node_modules/',
  '/dist/',
  '/.next/',
  '/coverage/',
  '/vault/',
  '/tests/',
];
const ENV_NAME_RE = /KYBERION_[A-Z0-9_]+/g;

export function classifyEnvName(name: string): { category: EnvCategory; type: EnvType } {
  // Flag prefixes win over the secret keyword scan: KYBERION_ALLOW_FILE_SECRETS
  // is an acknowledgement flag, not a secret value.
  if (
    /^KYBERION_(ALLOW|ENABLE|DISABLE|SKIP|NO|FORCE)_/.test(name) ||
    /_(ENABLED|DISABLED)$/.test(name)
  ) {
    return { category: 'flag', type: 'boolean' };
  }
  // Token counts are tuning values, not credentials. Keep this before the
  // generic TOKEN secret rule so context-window settings cannot be mislabeled
  // as secrets in generated configuration docs.
  if (/(?:_TOKENS|_COUNT|_LIMIT|_MAX|_MIN|_SIZE|_TTL|_RETRIES|_FACTOR|_SEC|_SECONDS)$/.test(name)) {
    return { category: 'tuning', type: 'number' };
  }
  if (/SECRET|TOKEN|_KEY$|_KEY_|PASSWORD|CREDENTIAL/.test(name)) {
    return { category: 'secret', type: 'string' };
  }
  if (/(_PATH|_DIR|_ROOT|_BIN|_FILE)$/.test(name) || name === 'KYBERION_ROOT') {
    return { category: 'path', type: 'path' };
  }
  if (/_(MS|TIMEOUT|INTERVAL|LIMIT|MAX|MIN|PORT|COUNT|SIZE|TTL|RETRIES|FACTOR)$/.test(name)) {
    return { category: 'tuning', type: 'number' };
  }
  if (/_(URL|HOST|ENDPOINT|MODEL|PROVIDER|BACKEND|COMMAND|CLI)$/.test(name)) {
    return { category: 'provider', type: 'string' };
  }
  return { category: 'runtime', type: 'string' };
}

export function discoverEnvNames(rootDir: string): string[] {
  const names = new Set<string>();
  for (const root of SCAN_ROOTS) {
    const dir = path.join(rootDir, root);
    if (!safeExistsSync(dir)) continue;
    for (const filePath of getAllFiles(dir)) {
      const normalized = `/${filePath.split(path.sep).join('/')}/`;
      if (EXCLUDED_PATH_SEGMENTS.some((segment) => normalized.includes(segment))) continue;
      if (!SCAN_EXTENSIONS.has(path.extname(filePath))) continue;
      if (
        filePath.endsWith('.d.ts') ||
        /(?:\.test|\.spec)\.[^.]+$/.test(filePath) ||
        filePath.includes(`${path.sep}__tests__${path.sep}`)
      ) {
        continue;
      }
      const content = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
      for (const match of content.matchAll(ENV_NAME_RE)) {
        // A trailing underscore is a dynamic prefix (for example
        // KYBERION_REASONING_ROLE_${role}), not a concrete registry key.
        if (!match[0].endsWith('_')) names.add(match[0]);
      }
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function mergeRegistry(
  discovered: string[],
  existing: EnvRegistryFile | null
): EnvRegistryFile {
  const existingByName = new Map<string, EnvRegistryEntry>(
    (existing?.entries || []).map((entry) => [entry.name, entry])
  );
  const entries = discovered.map((name) => {
    const current = existingByName.get(name);
    const { category, type } = classifyEnvName(name);
    if (current) {
      // Curated entries are preserved verbatim; undocumented ones track the
      // classifier so auto fields never go stale.
      return current.documented ? { ...current, name } : { ...current, name, category, type };
    }
    return {
      name,
      category,
      type,
      required: false,
      description: '',
      documented: false,
    } satisfies EnvRegistryEntry;
  });
  return {
    $schema: '../schemas/governance-catalog.schema.json',
    version: existing?.version || '1.0.0',
    description:
      existing?.description ||
      'Canonical registry of KYBERION_* environment variables (OP-05). Regenerate with pnpm generate:env-registry; curated fields are preserved.',
    entries,
  };
}

function renderEnvExample(registry: EnvRegistryFile): string {
  const lines: string[] = [
    '# Kyberion environment variables (generated from knowledge/product/governance/env-registry.json).',
    '# Regenerate with: pnpm generate:env-registry — do not edit by hand.',
    '# All variables are optional unless marked required. Never commit secret values.',
    '',
  ];
  for (const entry of registry.entries) {
    const meta = `[${entry.category}/${entry.type}${entry.required ? ', required' : ''}]`;
    const description = entry.description || 'Undocumented — classify in env-registry.json.';
    lines.push(`# ${meta} ${description}`);
    if (entry.enum?.length) lines.push(`#   values: ${entry.enum.join(' | ')}`);
    lines.push(`# ${entry.name}=${entry.default ?? ''}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function renderConfigurationDoc(registry: EnvRegistryFile): string {
  const categories: EnvCategory[] = ['secret', 'path', 'flag', 'tuning', 'provider', 'runtime'];
  const lines: string[] = [
    '# Kyberion Configuration Surface',
    '',
    '> Generated from `knowledge/product/governance/env-registry.json` by `pnpm generate:env-registry` — do not edit by hand.',
    '> `pnpm run check -- --scope full --only env-registry` (included in `pnpm validate`) fails when code references an unregistered `KYBERION_*` variable.',
    '',
    '## What belongs where',
    '',
    '- **Environment variables**: secrets, environment-specific endpoints/paths, and feature flags. Validated at startup by `libs/core/env-validator.ts` (warn by default; missing required values are errors).',
    '- **Registry fields**: `required: true` is reserved for an unconditional startup prerequisite and must also be `documented: true`; conditional capability prerequisites stay in the environment manifests. `documented: false` is an honest discovery state, not a runtime failure.',
    '- **Secrets**: may be documented by name and purpose, but their values never belong in this registry and they cannot be marked required here. Secret requirements are enforced by the selected capability or command.',
    '- **Config files (`knowledge/product/**`)**: policy thresholds (SA plans), model IDs (IP-13), catalogs and vocabularies. These need review, diffing, and schema validation — not per-host overrides.',
    '',
    'Copy [`env.example`](./env.example) to `.env` at the repo root for local overrides (the example is generated here because root dotfiles are write-protected by the policy engine).',
    '',
  ];
  for (const category of categories) {
    const entries = registry.entries.filter((entry) => entry.category === category);
    if (entries.length === 0) continue;
    lines.push(`## ${category} (${entries.length})`, '');
    lines.push('| Variable | Type | Required | Description |');
    lines.push('| --- | --- | --- | --- |');
    for (const entry of entries) {
      const typeLabel = entry.enum?.length ? `enum: ${entry.enum.join(' \\| ')}` : entry.type;
      const description = entry.description || '_undocumented_';
      lines.push(
        `| \`${entry.name}\` | ${typeLabel} | ${entry.required ? 'yes' : 'no'} | ${description} |`
      );
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

async function formatWithPrettier(content: string, filePath: string): Promise<string> {
  const config = (await resolvePrettierConfig(filePath)) ?? {};
  const parser = filePath.endsWith('.json') ? 'json' : 'markdown';
  return prettierFormat(content, { ...config, parser });
}

export const main = defineGenerator({
  id: 'env-registry',
  outputs: [REGISTRY_PATH, ENV_EXAMPLE_PATH, CONFIGURATION_DOC_PATH],
  async render(context) {
    const strictDocumentation =
      getRegisteredEnv<boolean>('KYBERION_ENV_REGISTRY_STRICT', { defaultValue: false }) === true;
    const rootDir = pathResolver.rootDir();
    const discovered = discoverEnvNames(rootDir);
    const existing = safeExistsSync(REGISTRY_PATH)
      ? readJson<EnvRegistryFile>(REGISTRY_PATH)
      : null;
    const built = mergeRegistry(discovered, existing);
    const qualityFailures = validateEnvRegistryQuality(built);
    if (qualityFailures.length > 0) {
      throw new Error(`env registry quality violations: ${qualityFailures.join('; ')}`);
    }
    if (strictDocumentation && context.check) {
      const undocumented = built.entries.filter((entry) => !entry.documented);
      if (undocumented.length > 0) {
        throw new Error(
          `env registry has ${undocumented.length} undocumented entr${undocumented.length === 1 ? 'y' : 'ies'}`
        );
      }
    }

    return [
      {
        path: REGISTRY_PATH,
        content: await formatWithPrettier(JSON.stringify(built, null, 2), REGISTRY_PATH),
      },
      { path: ENV_EXAMPLE_PATH, content: renderEnvExample(built) },
      {
        path: CONFIGURATION_DOC_PATH,
        content: await formatWithPrettier(renderConfigurationDoc(built), CONFIGURATION_DOC_PATH),
      },
    ];
  },
});

if (
  isDirectScript(import.meta.url, 'generate_env_registry.ts') ||
  isDirectScript(import.meta.url, 'generate_env_registry.js')
)
  void main();
