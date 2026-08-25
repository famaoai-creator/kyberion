import * as addFormatsModule from 'ajv-formats';
import * as path from 'node:path';
import {
  extractPlaceholderNames,
  loadActuatorManifestCatalog,
  loadJson,
  pathResolver,
  resolveVocabularyEntry,
  safeExistsSync,
  safeReadFile,
  safeReaddir,
  safeStat,
} from '@agent/core';
import { createAjv } from '@agent/core/foundation';
import { readJsonFile } from './refactor/cli-input.js';
import { generateIndex } from './generate_knowledge_index.js';
import {
  expectedKyberionThemeEntries,
  extractKyberionTokenBlock,
  readKyberionDesignTokens,
  renderKyberionDesignTokenBlock,
  renderKyberionTailwindColorsBlock,
} from './design-token-utils.js';
import { defineScript, isDirectScript } from './lib/harness.js';

const ajv = createAjv();
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;
addFormats(ajv);

type CatalogCheck = {
  id: string;
  schemaPath: string;
  dataPath: string;
};

const CHECKS: CatalogCheck[] = [
  {
    id: 'service-endpoints',
    schemaPath: 'knowledge/product/schemas/service-endpoints.schema.json',
    dataPath: 'knowledge/product/orchestration/service-endpoints.json',
  },
  {
    id: 'browser-passkey-providers',
    schemaPath: 'knowledge/product/schemas/browser-passkey-providers.schema.json',
    dataPath: 'knowledge/product/orchestration/browser-passkey-providers.json',
  },
  {
    id: 'browser-execution-presets',
    schemaPath: 'knowledge/product/schemas/browser-execution-presets.schema.json',
    dataPath: 'knowledge/product/orchestration/browser-execution-presets.json',
  },
  {
    id: 'android-ui-defaults',
    schemaPath: 'knowledge/product/schemas/android-ui-defaults.schema.json',
    dataPath: 'knowledge/product/orchestration/android-ui-defaults.json',
  },
  {
    id: 'actuator-request-archetypes',
    schemaPath: 'knowledge/product/schemas/actuator-request-archetypes.schema.json',
    dataPath: 'knowledge/product/orchestration/actuator-request-archetypes.json',
  },
  {
    id: 'mobile-app-profile-index',
    schemaPath: 'knowledge/product/schemas/mobile-app-profile-index.schema.json',
    dataPath: 'knowledge/product/orchestration/mobile-app-profiles/index.json',
  },
  {
    id: 'web-app-profile-index',
    schemaPath: 'knowledge/product/schemas/web-app-profile-index.schema.json',
    dataPath: 'knowledge/product/orchestration/web-app-profiles/index.json',
  },
  {
    id: 'user-facing-vocabulary',
    schemaPath: 'knowledge/product/schemas/user-facing-vocabulary.schema.json',
    dataPath: 'knowledge/product/orchestration/user-facing-vocabulary.json',
  },
  {
    id: 'specialist-catalog',
    schemaPath: 'knowledge/product/schemas/specialist-catalog.schema.json',
    dataPath: 'knowledge/product/orchestration/specialist-catalog.json',
  },
  {
    id: 'organization-operating-model',
    schemaPath: 'knowledge/product/schemas/organization-operating-model.schema.json',
    dataPath: 'knowledge/product/orchestration/organization-operating-model.json',
  },
  {
    id: 'organization-catalog',
    schemaPath: 'knowledge/product/schemas/organization-catalog.schema.json',
    dataPath: 'knowledge/product/orchestration/organization-catalog.json',
  },
  {
    id: 'cli-commands',
    schemaPath: 'knowledge/product/schemas/cli-commands.schema.json',
    dataPath: 'knowledge/product/governance/cli-commands.json',
  },
];

function readJson<T>(relativePath: string): T {
  const fullPath = pathResolver.rootResolve(relativePath);
  return readJsonFile(fullPath);
}

function validateCatalog(check: CatalogCheck, violations: string[], warnings: string[]) {
  const schema = readJson<Record<string, unknown>>(check.schemaPath);
  if (check.id === 'organization-catalog') {
    for (const dependency of [
      'organization-domain.schema.json',
      'organization-capability.schema.json',
      'organization-service.schema.json',
    ]) {
      const dependencySchema = readJson<Record<string, unknown>>(
        `knowledge/product/schemas/${dependency}`
      );
      if (!ajv.getSchema(String(dependencySchema.$id || dependency))) {
        ajv.addSchema(dependencySchema);
      }
    }
  }
  const data = readJson<Record<string, unknown>>(check.dataPath);
  const validate = ajv.compile(schema);
  const ok = validate(data);
  if (!ok) {
    for (const error of validate.errors || []) {
      violations.push(
        `${check.id}: ${error.instancePath || '/'} ${error.message || 'schema violation'}`
      );
    }
  }

  if (check.id === 'service-endpoints') {
    const typed = data as {
      default_pattern?: string;
      services?: Record<string, { base_url?: string; intent_aliases?: string[] }>;
    };
    const services = typed.services || {};
    if (Object.keys(services).length === 0) {
      violations.push('service-endpoints: services must not be empty');
    }

    const directory = pathResolver.rootResolve('knowledge/product/orchestration/service-endpoints');
    if (!safeExistsSync(directory)) {
      violations.push('service-endpoints: canonical directory is missing');
      return;
    }

    const fileNames = safeReaddir(directory)
      .filter((entry) => entry.endsWith('.json'))
      .sort();
    if (fileNames.length === 0) {
      violations.push('service-endpoints: canonical directory is empty');
      return;
    }

    const directoryServiceIds: string[] = [];
    for (const fileName of fileNames) {
      const filePath = pathResolver.rootResolve(path.join(directory, fileName));
      const payload = loadJson<typeof typed>(filePath) as {
        default_pattern?: string;
        services?: Record<string, unknown>;
      };
      const snapshotServices = typed.services || {};
      const payloadValidate = ajv.compile(schema);
      if (!payloadValidate(payload)) {
        for (const error of payloadValidate.errors || []) {
          violations.push(
            `service-endpoints: ${fileName}${error.instancePath || '/'} ${error.message || 'schema violation'}`
          );
        }
      }
      const payloadServices = payload.services || {};
      const payloadServiceIds = Object.keys(payloadServices);
      if (payloadServiceIds.length !== 1) {
        violations.push(`service-endpoints: ${fileName} must contain exactly one service`);
        continue;
      }
      const serviceId = payloadServiceIds[0];
      if (fileName.replace(/\.json$/i, '') !== serviceId) {
        violations.push(`service-endpoints: ${fileName} must match service id ${serviceId}`);
      }
      if (payload.default_pattern !== typed.default_pattern) {
        violations.push(`service-endpoints: ${fileName} default_pattern must match the snapshot`);
      }
      const snapshotAliasList = snapshotServices[serviceId]?.intent_aliases || [];
      const payloadAliasList =
        (payloadServices[serviceId] as { intent_aliases?: string[] } | undefined)?.intent_aliases ||
        [];
      if (JSON.stringify(snapshotAliasList) !== JSON.stringify(payloadAliasList)) {
        violations.push(`service-endpoints: ${fileName} intent_aliases must match the snapshot`);
      }
      directoryServiceIds.push(serviceId);
    }

    const snapshotServiceIds = Object.keys(services).sort();
    if (directoryServiceIds.sort().join(',') !== snapshotServiceIds.join(',')) {
      violations.push('service-endpoints: directory services must match snapshot services');
    }
  }

  if (check.id === 'browser-passkey-providers') {
    const typed = data as { default_provider?: string; providers?: Record<string, unknown> };
    if (!typed.providers?.[String(typed.default_provider || '')]) {
      violations.push('browser-passkey-providers: default_provider must exist in providers');
    }
  }

  if (check.id === 'browser-execution-presets') {
    const typed = data as { default_preset?: string; presets?: Record<string, unknown> };
    if (!typed.presets?.[String(typed.default_preset || '')]) {
      violations.push('browser-execution-presets: default_preset must exist in presets');
    }
  }

  if (check.id === 'actuator-request-archetypes') {
    const typed = data as { default_archetype?: string; archetypes?: Array<{ id?: string }> };
    const ids = new Set((typed.archetypes || []).map((item) => String(item.id || '')));
    if (!ids.has(String(typed.default_archetype || ''))) {
      violations.push('actuator-request-archetypes: default_archetype must exist in archetypes');
    }
  }

  if (check.id === 'mobile-app-profile-index' || check.id === 'web-app-profile-index') {
    const typed = data as { profiles?: Array<{ path?: string }> };
    for (const profile of typed.profiles || []) {
      const profilePath = String(profile.path || '');
      if (!profilePath) continue;
      if (!safeExistsSync(pathResolver.rootResolve(profilePath))) {
        violations.push(`${check.id}: referenced profile not found (${profilePath})`);
      }
    }
  }

  if (check.id === 'user-facing-vocabulary') {
    validateUserFacingVocabulary(data, violations, warnings);
  }

  if (check.id === 'specialist-catalog') {
    const typed = data as { version?: string; specialists?: Record<string, unknown> };
    const specialists = typed.specialists || {};
    if (Object.keys(specialists).length === 0) {
      violations.push('specialist-catalog: specialists must not be empty');
    }

    const directory = pathResolver.rootResolve('knowledge/product/orchestration/specialists');
    if (!safeExistsSync(directory)) {
      violations.push('specialist-catalog: canonical directory is missing');
      return;
    }

    const fileNames = safeReaddir(directory)
      .filter((entry) => entry.endsWith('.json'))
      .sort();
    if (fileNames.length === 0) {
      violations.push('specialist-catalog: canonical directory is empty');
      return;
    }

    const directoryIds: string[] = [];
    for (const fileName of fileNames) {
      const filePath = pathResolver.rootResolve(path.join(directory, fileName));
      const payload = loadJson<typeof typed>(filePath) as {
        version?: string;
        specialists?: Record<string, unknown>;
      };
      const payloadValidate = ajv.compile(schema);
      if (!payloadValidate(payload)) {
        for (const error of payloadValidate.errors || []) {
          violations.push(
            `specialist-catalog: ${fileName}${error.instancePath || '/'} ${error.message || 'schema violation'}`
          );
        }
      }
      const payloadSpecialists = payload.specialists || {};
      const specialistIds = Object.keys(payloadSpecialists);
      if (specialistIds.length !== 1) {
        violations.push(`specialist-catalog: ${fileName} must contain exactly one specialist`);
        continue;
      }
      const specialistId = specialistIds[0];
      if (fileName.replace(/\.json$/i, '') !== specialistId) {
        violations.push(`specialist-catalog: ${fileName} must match specialist id ${specialistId}`);
      }
      if (payload.version !== typed.version) {
        violations.push(`specialist-catalog: ${fileName} version must match the snapshot`);
      }
      directoryIds.push(specialistId);
    }

    if (directoryIds.sort().join(',') !== Object.keys(specialists).sort().join(',')) {
      violations.push('specialist-catalog: directory specialists must match snapshot specialists');
    }
  }
}

type VocabularyEntry = Record<string, string>;
interface VocabularyCatalogShape {
  default_locale?: string;
  required_locales?: string[];
  domains?: Record<string, Record<string, VocabularyEntry>>;
}

// I18N-02: directories scanned for both directions of the code<->catalog
// cross-check below. `renderStatus`'s STATUS_KEY_MAP lives inside
// ux-vocabulary.ts itself, so scanning libs/core already covers it for the
// unused-key (reverse) check even though it is not one of the literal call
// patterns scanned for the undefined-key (forward) check.
const VOCABULARY_SCAN_DIRS = [
  'libs/core',
  'scripts',
  'presence/displays/chronos-mirror-v2/src',
  'presence/displays/operator-surface/src',
  'presence/displays/concierge/src',
  'satellites',
  'tests',
];

function collectSourceFiles(rootRelativeDirs: string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!safeExistsSync(dir)) return;
    for (const entry of safeReaddir(dir) as string[]) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.next' || entry === '.git') {
        continue;
      }
      const full = path.join(dir, entry);
      const stat = safeStat(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry)) files.push(full);
    }
  };
  for (const rel of rootRelativeDirs) walk(pathResolver.rootResolve(rel));
  return files;
}

// Forward direction: a `t`, `uxText`, `uxLabel`, or `renderVocabularyText`
// call whose literal key argument does not resolve against the catalog.
// Restricted to these named call patterns (not a bare `t(` scan across every
// directory) because `scripts/onboarding_wizard.ts` defines its own
// unrelated two-argument `t(en, ja)` helper — a bare-`t(` scan would
// misidentify its calls as vocabulary-key references and fail on every one
// of them. `scripts/cli.ts` is the one script-level exception: its local
// `t()` is a verified thin delegate to the core vocabulary `t()` (I18N-02),
// so it is scanned by name.
//
// `uxTextOr` is deliberately excluded: per its own doc comment it is the
// "fallback-carrying variant for DYNAMIC keys only" — a key it references is
// allowed not to resolve (that's the point of the fallback argument), so
// checking it here would turn an intentional escape hatch into a build
// failure.
const KNOWN_KEY_CALL_RE = /\b(?:uxText|uxLabel|renderVocabularyText)\(\s*'([^']+)'/g;
const CLI_T_CALL_RE = /\bt\(\s*'([^']+)'/g;

/**
 * Pure core of the forward code→catalog check.
 *
 * `sources` maps a repo-relative label to that file's text, and `resolveKey`
 * answers whether a key exists (throwing on ambiguity). Keeping the scan
 * separate from the reading is what lets the suite exercise it with fixture
 * text instead of writing a file into the repo and re-running the checker as a
 * subprocess — the pattern check_mission_gate_docs.ts already uses.
 */
export function collectUndefinedKeyReferenceViolations(
  sources: Record<string, string>,
  resolveKey: (key: string) => unknown = resolveVocabularyEntry
): string[] {
  const violations: string[] = [];
  for (const [label, source] of Object.entries(sources)) {
    // Only scripts/cli.ts uses the bare `t('…')` form; scanning every file for
    // it would collide with unrelated one-letter helpers.
    const normalizedLabel = label.replaceAll('\\', '/');
    const isCliScript =
      normalizedLabel === 'scripts/cli.ts' || normalizedLabel.endsWith('/scripts/cli.ts');
    const matches = [
      ...source.matchAll(KNOWN_KEY_CALL_RE),
      ...(isCliScript ? source.matchAll(CLI_T_CALL_RE) : []),
    ];
    for (const match of matches) {
      const key = match[1];
      try {
        if (!resolveKey(key)) {
          violations.push(`user-facing-vocabulary: ${label} references undefined key "${key}"`);
        }
      } catch (error) {
        violations.push(
          `user-facing-vocabulary: ${label} references ambiguous key "${key}" (${(error as Error).message})`
        );
      }
    }
  }
  return violations;
}

function findUndefinedKeyReferences(files: string[]): string[] {
  const sources: Record<string, string> = {};
  for (const file of files) {
    const label = path.relative(pathResolver.rootDir(), file);
    sources[label] = String(safeReadFile(file, { encoding: 'utf8' }) || '');
  }
  return collectUndefinedKeyReferenceViolations(sources);
}

/**
 * Reverse direction: a catalog key that no scanned file references as a
 * quoted string literal at all (not restricted to the call patterns above —
 * this also catches `STATUS_KEY_MAP`/`keyMap` object-literal values that are
 * vocabulary keys but not passed directly to a `t()`-shaped call).
 *
 * Policy: **warning, not a build failure.** Unlike the forward check (a
 * literal string that fails to resolve is unambiguously a typo/bug), "no
 * quoted-literal occurrence anywhere in the scanned trees" has real false
 * positive risk — a key can legitimately be referenced only via a template
 * literal or computed key (`` uxText(`chronos_qa_action_${id}`) ``) that this
 * regex-based scan cannot see. Failing the build on a heuristic with known
 * blind spots would make `check:catalogs` untrustworthy; surfacing it as a
 * warning keeps the signal (catalog hygiene, dead-key cleanup) without that
 * risk. I18N-08's translation-ops audit is the place to make this stricter
 * once a lower-false-positive detector exists.
 */
function findUnusedKeys(catalog: VocabularyCatalogShape, haystack: string): string[] {
  const unused: string[] = [];
  for (const [namespace, entries] of Object.entries(catalog.domains || {})) {
    for (const key of Object.keys(entries || {})) {
      if (!haystack.includes(`'${key}'`) && !haystack.includes(`"${key}"`)) {
        unused.push(
          `user-facing-vocabulary: ${namespace}.${key} is not referenced anywhere scanned`
        );
      }
    }
  }
  return unused;
}

/**
 * Pure core of the vocabulary catalog checks: required locales present for
 * every key, and placeholders consistent across locales for the same key.
 *
 * Takes the parsed catalog and returns violations, so the suite can assert on a
 * fixture catalog rather than editing the repository's real
 * user-facing-vocabulary.json and restoring it afterwards. That editing was the
 * source of cross-file interference: vitest runs files in parallel, so any suite
 * reading the catalog while it was deliberately broken saw the injected drift.
 */
export function collectVocabularyCatalogViolations(data: Record<string, unknown>): string[] {
  const violations: string[] = [];
  const typed = data as VocabularyCatalogShape;
  const defaultLocale = String(typed.default_locale || '');
  const requiredLocales = typed.required_locales || [];
  const domains = typed.domains || {};

  if (!defaultLocale) {
    violations.push('user-facing-vocabulary: default_locale must not be empty');
  }
  if (requiredLocales.length === 0) {
    violations.push('user-facing-vocabulary: required_locales must not be empty');
  }
  if (defaultLocale && requiredLocales.length > 0 && !requiredLocales.includes(defaultLocale)) {
    violations.push(
      `user-facing-vocabulary: default_locale "${defaultLocale}" must be a member of required_locales`
    );
  }

  for (const [domainName, domainEntries] of Object.entries(domains)) {
    for (const [entryKey, localized] of Object.entries(domainEntries || {})) {
      // Every required locale must be present (not just default_locale —
      // I18N-02 closes the gap where a `ja`-missing key silently passed).
      for (const locale of requiredLocales) {
        if (!localized[locale]) {
          violations.push(
            `user-facing-vocabulary: ${domainName}.${entryKey} must define required locale "${locale}"`
          );
        }
      }
      // Placeholders must match across locales for the same key (en has
      // `{name}`, ja does not -> fail).
      const localeTexts = requiredLocales
        .filter((locale) => typeof localized[locale] === 'string')
        .map((locale) => ({ locale, text: localized[locale] }));
      if (localeTexts.length > 1) {
        const reference = localeTexts[0];
        const referencePlaceholders = extractPlaceholderNames(reference.text).sort().join(',');
        for (const other of localeTexts.slice(1)) {
          const otherPlaceholders = extractPlaceholderNames(other.text).sort().join(',');
          if (otherPlaceholders !== referencePlaceholders) {
            violations.push(
              `user-facing-vocabulary: ${domainName}.${entryKey} placeholders differ between "${reference.locale}" (${referencePlaceholders || 'none'}) and "${other.locale}" (${otherPlaceholders || 'none'})`
            );
          }
        }
      }
    }
  }

  return violations;
}

function validateUserFacingVocabulary(
  data: Record<string, unknown>,
  violations: string[],
  warnings: string[]
) {
  violations.push(...collectVocabularyCatalogViolations(data));

  const files = collectSourceFiles(VOCABULARY_SCAN_DIRS);
  violations.push(...findUndefinedKeyReferences(files));

  const haystack = files
    .map((file) => String(safeReadFile(file, { encoding: 'utf8' }) || ''))
    .join('\n');
  warnings.push(...findUnusedKeys(data as VocabularyCatalogShape, haystack));
}

export interface ThemeEntryShape {
  colors?: Record<string, string>;
  fonts?: Record<string, string>;
}

export interface ThemeCatalogShape {
  default_theme?: string;
  themes?: Record<string, ThemeEntryShape>;
}

/**
 * Pure core of the theme-catalog drift check.
 *
 * The generated design tokens are the source of truth; a theme catalog must
 * reproduce them exactly. Comparing supplied data rather than re-reading the
 * repository means the suite can assert on a drifted fixture without editing
 * `themes.json` in place — an edit that other suites running in parallel would
 * otherwise observe.
 */
export function collectThemeCatalogViolations(input: {
  label: string;
  catalog: ThemeCatalogShape;
  expectedThemes: Record<string, ThemeEntryShape>;
  isRootThemesCatalog: boolean;
}): string[] {
  const violations: string[] = [];
  const { label, catalog, expectedThemes, isRootThemesCatalog } = input;

  if (isRootThemesCatalog && catalog.default_theme !== 'kyberion-standard') {
    violations.push(`design-tokens: ${label} default_theme must be kyberion-standard`);
  }

  for (const themeName of ['kyberion-standard', 'kyberion-sovereign'] as const) {
    const actual = catalog.themes?.[themeName];
    const expected = expectedThemes[themeName];
    if (!expected) continue;
    if (
      JSON.stringify(actual?.colors) !== JSON.stringify(expected.colors) ||
      JSON.stringify(actual?.fonts) !== JSON.stringify(expected.fonts)
    ) {
      violations.push(`design-tokens: ${label} ${themeName} drift`);
    }
  }
  return violations;
}

function validateDesignTokenCatalog(violations: string[]) {
  const tokens = readKyberionDesignTokens();
  const expectedTokenBlock = renderKyberionDesignTokenBlock(tokens);
  const expectedTailwindBlock = renderKyberionTailwindColorsBlock();
  const expectedThemes = expectedKyberionThemeEntries(tokens);

  const tokenFiles = [
    'presence/displays/chronos-mirror-v2/src/app/globals.css',
    'presence/displays/operator-surface/src/app/globals.css',
    'presence/displays/presence-studio/static/design-tokens.css',
    'presence/displays/computer-surface/static/design-tokens.css',
  ].map((relativePath) => pathResolver.rootResolve(relativePath));

  for (const filePath of tokenFiles) {
    if (!safeExistsSync(filePath)) {
      violations.push(
        `design-tokens: missing file ${path.relative(pathResolver.rootDir(), filePath)}`
      );
      continue;
    }
    const actual = String(safeReadFile(filePath, { encoding: 'utf8' }) || '').trim();
    if (filePath.endsWith('globals.css')) {
      const tokenBlock = extractKyberionTokenBlock(actual);
      if (tokenBlock !== expectedTokenBlock) {
        violations.push(
          `design-tokens: token block drift in ${path.relative(pathResolver.rootDir(), filePath)}`
        );
      }
      continue;
    }
    if (actual !== expectedTokenBlock) {
      violations.push(
        `design-tokens: token block drift in ${path.relative(pathResolver.rootDir(), filePath)}`
      );
    }
  }

  const tailwindPath = pathResolver.rootResolve(
    'presence/displays/chronos-mirror-v2/tailwind.config.cjs'
  );
  if (!safeExistsSync(tailwindPath)) {
    violations.push('design-tokens: missing tailwind.config.cjs');
  } else {
    const tailwindText = String(safeReadFile(tailwindPath, { encoding: 'utf8' }) || '');
    if (!tailwindText.includes(expectedTailwindBlock)) {
      violations.push('design-tokens: kyberion tailwind color block drift');
    }
  }

  const themeFiles = [
    'knowledge/public/design-patterns/media-templates/themes.json',
    'knowledge/public/design-patterns/media-templates/themes/themes.json',
  ].map((relativePath) => pathResolver.rootResolve(relativePath));

  for (const filePath of themeFiles) {
    if (!safeExistsSync(filePath)) {
      violations.push(
        `design-tokens: missing file ${path.relative(pathResolver.rootDir(), filePath)}`
      );
      continue;
    }
    const raw = loadJson<ThemeCatalogShape>(filePath);
    violations.push(
      ...collectThemeCatalogViolations({
        label: path.relative(pathResolver.rootDir(), filePath),
        catalog: raw,
        expectedThemes,
        // Only the flat catalog declares default_theme; the decomposed copy
        // under themes/ inherits it.
        isRootThemesCatalog: path.basename(path.dirname(filePath)) !== 'themes',
      })
    );
  }

  // E2E-02: the flat catalog and the decomposed directory copy are a generated
  // pair; their theme maps must stay identical so neither drifts silently.
  try {
    const flat = loadJson<{ themes?: Record<string, unknown> }>(themeFiles[0]);
    const nested = loadJson<{ themes?: Record<string, unknown> }>(themeFiles[1]);
    if (JSON.stringify(flat.themes || {}) !== JSON.stringify(nested.themes || {})) {
      violations.push(
        'design-tokens: themes.json and themes/themes.json theme maps diverged. Run pnpm tsx scripts/generate_design_tokens.ts and align manual edits.'
      );
    }
  } catch {
    // missing-file violations are already reported above
  }
}

function validateCapabilitiesGuideDrift(violations: string[]) {
  const guidePath = pathResolver.rootResolve('CAPABILITIES_GUIDE.md');
  if (!safeExistsSync(guidePath)) {
    violations.push('capabilities-guide: CAPABILITIES_GUIDE.md is missing');
    return;
  }
  const guide = safeReadFile(guidePath, { encoding: 'utf8' }) as string;
  const catalog = loadActuatorManifestCatalog();
  const totalMatch = guide.match(/Total Actuators:\s*(\d+)/u);
  const guideTotal = totalMatch ? Number(totalMatch[1]) : NaN;
  if (guideTotal !== catalog.length) {
    violations.push(
      `capabilities-guide: Total Actuators mismatch (${guideTotal} !== ${catalog.length})`
    );
  }
  if (
    !/\|\s*Actuator\s*\|\s*Description\s*\|\s*Version\s*\|\s*Ops Count\s*\|\s*Ops\s*\|\s*Prerequisites\s*\|\s*Contract Schema\s*\|\s*Path\s*\|/u.test(
      guide
    )
  ) {
    violations.push('capabilities-guide: generated table must include Prerequisites column');
  }
  for (const entry of catalog) {
    if (!guide.includes(`\`${entry.n}\``)) {
      violations.push(`capabilities-guide: missing actuator ${entry.n}`);
    }
  }
}

export const runCheckCatalogIntegrity = defineScript({
  name: 'check:catalogs',
  flags: [],
  run(context) {
    const violations: string[] = [];
    const warnings: string[] = [];
    for (const check of CHECKS) {
      validateCatalog(check, violations, warnings);
    }
    validateDesignTokenCatalog(violations);
    validateCapabilitiesGuideDrift(violations);

    const indexUpToDate = generateIndex(true);
    if (!indexUpToDate) {
      violations.push(
        'knowledge: _index.md or _integrity-manifest.json is out of date. Run pnpm generate:knowledge-index to update.'
      );
    }

    if (warnings.length > 0) {
      console.warn('[check:catalogs] warnings (non-fatal):');
      for (const warning of warnings.sort()) {
        console.warn(`- ${warning}`);
      }
    }

    if (violations.length > 0) {
      console.error('[check:catalogs] violations detected:');
      for (const violation of violations.sort()) {
        console.error(`- ${violation}`);
      }
      throw new Error(`${violations.length} catalog integrity violation(s)`);
    }

    context.print('[check:catalogs] OK');
  },
});

// Guarded so importing the pure collectors above does not run the whole
// repository check as a side effect.
if (
  isDirectScript(import.meta.url, 'check_catalog_integrity.ts') ||
  isDirectScript(import.meta.url, 'check_catalog_integrity.js')
)
  void runCheckCatalogIntegrity();
