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
 *   pnpm check:env-registry             — fail if any artifact drifted
 */

import * as path from 'node:path';
import { format as prettierFormat, resolveConfig as resolvePrettierConfig } from 'prettier';
import { pathResolver, safeExistsSync, safeReadFile, safeWriteFile } from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import { withExecutionContext } from '@agent/core/governance';

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
  version: string;
  description: string;
  entries: EnvRegistryEntry[];
}

const REGISTRY_PATH = pathResolver.knowledge('product/governance/env-registry.json');
const ENV_EXAMPLE_PATH = pathResolver.rootResolve('docs/developer/env.example');
const CONFIGURATION_DOC_PATH = pathResolver.rootResolve('docs/developer/CONFIGURATION.md');

const SCAN_ROOTS = ['libs', 'scripts', 'satellites', 'presence', 'pipelines', 'tests'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const EXCLUDED_PATH_SEGMENTS = ['/node_modules/', '/dist/', '/.next/', '/coverage/', '/vault/'];
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
      if (filePath.endsWith('.d.ts')) continue;
      const content = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
      for (const match of content.matchAll(ENV_NAME_RE)) {
        names.add(match[0]);
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
    '> `pnpm check:env-registry` (part of `pnpm validate`) fails when code references an unregistered `KYBERION_*` variable.',
    '',
    '## What belongs where',
    '',
    '- **Environment variables**: secrets, environment-specific endpoints/paths, and feature flags. Validated at startup by `libs/core/env-validator.ts` (warn by default; missing required values are errors).',
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

function readIfExists(filePath: string): string | null {
  return safeExistsSync(filePath)
    ? String(safeReadFile(filePath, { encoding: 'utf8' }) || '')
    : null;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const shouldCheck = argv.includes('--check');
  const rootDir = pathResolver.rootDir();

  const built = withExecutionContext('ecosystem_architect', () => {
    const discovered = discoverEnvNames(rootDir);
    const existingRaw = readIfExists(REGISTRY_PATH);
    const existing = existingRaw ? (JSON.parse(existingRaw) as EnvRegistryFile) : null;
    return mergeRegistry(discovered, existing);
  });

  const registryJson = await formatWithPrettier(JSON.stringify(built, null, 2), REGISTRY_PATH);
  const envExample = renderEnvExample(built);
  const configurationDoc = await formatWithPrettier(
    renderConfigurationDoc(built),
    CONFIGURATION_DOC_PATH
  );

  const targets: Array<{ label: string; filePath: string; next: string }> = [
    { label: 'env registry', filePath: REGISTRY_PATH, next: registryJson },
    // docs/developer/ writes are allowlisted for the ecosystem_architect
    // persona in security-policy.json (registration ceremony, same pattern
    // as CAPABILITIES_GUIDE.md).
    { label: 'env.example', filePath: ENV_EXAMPLE_PATH, next: envExample },
    { label: 'configuration doc', filePath: CONFIGURATION_DOC_PATH, next: configurationDoc },
  ];

  if (shouldCheck) {
    const drifted = targets.filter((target) => readIfExists(target.filePath) !== target.next);
    if (drifted.length === 0) {
      console.log('env registry is up to date');
      return;
    }
    console.error('env registry drift detected — run pnpm generate:env-registry');
    for (const target of drifted) {
      console.error(`- ${path.relative(rootDir, target.filePath)} differs`);
    }
    process.exitCode = 1;
    return;
  }

  return withExecutionContext('ecosystem_architect', () => {
    for (const target of targets) {
      safeWriteFile(target.filePath, target.next);
      console.log(`wrote ${path.relative(rootDir, target.filePath)}`);
    }
  });
}

if (process.argv[1] && /generate_env_registry\.(ts|js)$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
