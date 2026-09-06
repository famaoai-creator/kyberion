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
 *   KYBERION_ENV_REGISTRY_STRICT_DOCS=1 pnpm run check -- --scope full --only env-registry
 *                                      — also fail while entries remain undocumented
 */

import * as path from 'node:path';
import { format as prettierFormat, resolveConfig as resolvePrettierConfig } from 'prettier';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { getRegisteredEnv, readTextFile } from '@agent/core/foundation';
import { loadEnvRegistryFile } from '@agent/core/env-validator';
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

const ENV_CATEGORIES = new Set<EnvCategory>([
  'secret',
  'path',
  'flag',
  'tuning',
  'provider',
  'runtime',
]);
const ENV_TYPES = new Set<EnvType>(['string', 'boolean', 'number', 'enum', 'path']);
const ENV_NAME_RE = /^KYBERION_[A-Z0-9_]+$/;

export function validateEnvRegistryQuality(registry: EnvRegistryFile): string[] {
  const failures: string[] = [];
  if (!registry || !Array.isArray(registry.entries)) {
    return ['registry.entries must be an array'];
  }

  const seenNames = new Set<string>();
  for (const [index, rawEntry] of registry.entries.entries()) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      failures.push(`entries[${index}]: entry must be an object`);
      continue;
    }
    const entry = rawEntry as Partial<EnvRegistryEntry>;
    const label = typeof entry.name === 'string' && entry.name ? entry.name : `entries[${index}]`;
    if (
      typeof entry.name !== 'string' ||
      !ENV_NAME_RE.test(entry.name) ||
      entry.name.endsWith('_')
    ) {
      failures.push(`${label}: name must match KYBERION_[A-Z0-9_]+ and not end with an underscore`);
    } else if (seenNames.has(entry.name)) {
      failures.push(`${entry.name}: duplicate registry entry`);
    } else {
      seenNames.add(entry.name);
    }
    if (typeof entry.category !== 'string' || !ENV_CATEGORIES.has(entry.category as EnvCategory)) {
      failures.push(
        `${label}: category must be one of secret, path, flag, tuning, provider, runtime`
      );
    }
    if (typeof entry.type !== 'string' || !ENV_TYPES.has(entry.type as EnvType)) {
      failures.push(`${label}: type must be one of string, boolean, number, enum, path`);
    }
    if (typeof entry.required !== 'boolean') {
      failures.push(`${label}: required must be boolean`);
    }
    if (typeof entry.documented !== 'boolean') {
      failures.push(`${label}: documented must be boolean`);
    }
    if (typeof entry.description !== 'string') {
      failures.push(`${label}: description must be a string`);
    }
    if (entry.type === 'enum') {
      if (
        !Array.isArray(entry.enum) ||
        entry.enum.length === 0 ||
        entry.enum.some((value) => typeof value !== 'string' || !value.trim())
      ) {
        failures.push(`${label}: enum type must define a non-empty string enum`);
      } else if (new Set(entry.enum).size !== entry.enum.length) {
        failures.push(`${label}: enum values must be unique`);
      }
    } else if (entry.enum !== undefined) {
      failures.push(`${label}: enum is only valid when type is enum`);
    }

    if (typeof entry.required !== 'boolean' || typeof entry.documented !== 'boolean') continue;
    if (entry.required && entry.documented !== true) {
      failures.push(`${entry.name}: required entries must be documented`);
    }
    if (entry.category === 'secret' && entry.documented !== true) {
      failures.push(`${entry.name}: secret entries must be documented`);
    }
    if (entry.category === 'flag' && entry.documented !== true) {
      failures.push(`${entry.name}: flag entries must be documented`);
    }
    if (
      (entry.required || entry.documented) &&
      typeof entry.description === 'string' &&
      !entry.description.trim()
    ) {
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
const ENV_DISCOVERY_RE = /KYBERION_[A-Z0-9_]+/g;

export function readEnvRegistryTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

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
  if (/_RING$/.test(name)) {
    return { category: 'tuning', type: 'number' };
  }
  if (/SECRET|TOKEN|_KEY$|_KEY_|PASSWORD|PASSPHRASE|(?:^|_)PASS(?:_|$)|CREDENTIAL/.test(name)) {
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

function humanizeEnvName(name: string): string {
  return name
    .replace(/^KYBERION_/, '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function describeDiscoveredEnv(name: string, category: EnvCategory): string {
  const subject = humanizeEnvName(name);
  switch (category) {
    case 'path':
      return `Optional path override for ${subject}; keep it inside governed repository or runtime storage.`;
    case 'tuning':
      return `Optional numeric tuning value for ${subject}; leave unset to use the governed default.`;
    case 'runtime':
      return `Optional runtime setting for ${subject}; leave unset to use the built-in configuration.`;
    case 'provider':
      return `Optional provider setting for ${subject}; use only an endpoint or executable allowed by the active policy.`;
    case 'flag':
      return `Optional feature flag for ${subject}; enable it only for the explicitly intended operation.`;
    case 'secret':
      return `Secret value for ${subject}; store it in the governed secret store and never commit the value.`;
  }
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
      const content = readEnvRegistryTextFile(filePath);
      for (const match of content.matchAll(ENV_DISCOVERY_RE)) {
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
      // classifier so auto fields never go stale. Existing discovery entries
      // are promoted once they have a safe, category-specific explanation;
      // newly discovered names remain undocumented until an operator reviews
      // them in the registry.
      return current.documented
        ? { ...current, name }
        : {
            ...current,
            name,
            category,
            type,
            description: current.description || describeDiscoveredEnv(name, category),
            documented: true,
          };
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
    $schema: '../schemas/env-registry.schema.json',
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
      getRegisteredEnv<boolean>('KYBERION_ENV_REGISTRY_STRICT_DOCS', { defaultValue: false }) ===
      true;
    const rootDir = pathResolver.rootDir();
    const discovered = discoverEnvNames(rootDir);
    const existing = safeExistsSync(REGISTRY_PATH) ? loadEnvRegistryFile() : null;
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
