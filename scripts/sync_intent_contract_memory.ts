import {
  compileSchemaFromPath,
  isValidTenantSlug,
  logger,
  pathResolver,
  physicalScopedPath,
  resolveIntentContractMemoryPaths,
  safeExistsSync,
  safeWriteFile,
} from '@agent/core';
import { createAjv } from '@agent/core/foundation';
import { readJsonFile } from './refactor/cli-input.js';

const ajv = createAjv();

const MEMORY_SCHEMA_PATH =
  process.env.KYBERION_INTENT_CONTRACT_MEMORY_SCHEMA_PATH ||
  pathResolver.knowledge('product/schemas/intent-contract-memory.schema.json');
const DEFAULT_REPORT_PATH =
  process.env.KYBERION_INTENT_CONTRACT_MEMORY_REPORT_PATH ||
  pathResolver.shared('runtime/reports/intent-contract-memory-sync-latest.json');
const DEFAULT_EXPORT_DIR =
  process.env.KYBERION_INTENT_CONTRACT_MEMORY_EXPORT_DIR ||
  pathResolver.shared('exports/intent-contract-memory-sync');

type MemoryFile = {
  version: string;
  entries: Array<
    {
      intent_id: string;
      contract_ref: { kind: string; ref: string };
    } & Record<string, unknown>
  >;
};

function readJson<T>(absPath: string): T {
  return readJsonFile(absPath);
}

function validateMemory(value: unknown): asserts value is MemoryFile {
  const validate = compileSchemaFromPath(ajv as any, MEMORY_SCHEMA_PATH);
  if (!validate(value)) {
    const errors = (validate.errors || [])
      .map((e) => `${e.instancePath || '/'} ${e.message || 'schema violation'}`)
      .join('; ');
    throw new Error(`intent-contract-memory schema violation: ${errors}`);
  }
}

function entryKey(entry: {
  intent_id: string;
  contract_ref: { kind: string; ref: string };
}): string {
  return `${entry.intent_id}::${entry.contract_ref.kind}::${entry.contract_ref.ref}`;
}

function getOptionValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('-')) return undefined;
  return value;
}

function resolveTenantScope(): { tier: 'confidential'; tenant_slug: string } | undefined {
  const tenant = getOptionValue('--tenant')?.trim();
  if (!tenant) return undefined;
  if (!isValidTenantSlug(tenant)) {
    throw new Error(`[SCOPE_CONTEXT_INVALID] invalid tenant slug '${tenant}'`);
  }
  return { tier: 'confidential', tenant_slug: tenant };
}

function scopedReportPath(
  scope: { tier: 'confidential'; tenant_slug: string } | undefined
): string {
  if (!scope) return DEFAULT_REPORT_PATH;
  return pathResolver.resolve(
    physicalScopedPath(
      'active/shared/runtime',
      { ...scope, scope_kind: 'tenant' },
      'reports',
      'intent-contract-memory-sync-latest.json'
    )
  );
}

function scopedExportDir(scope: { tier: 'confidential'; tenant_slug: string } | undefined): string {
  if (!scope) return DEFAULT_EXPORT_DIR;
  return pathResolver.resolve(
    physicalScopedPath(
      'active/shared/exports',
      { ...scope, scope_kind: 'tenant' },
      'intent-contract-memory-sync'
    )
  );
}

function main(): void {
  const scope = resolveTenantScope();
  const reportPath = getOptionValue('--report') || scopedReportPath(scope);
  const exportDir = getOptionValue('--export-dir') || scopedExportDir(scope);
  const persistExport = process.argv.includes('--persist-export');
  const syncSeed = process.argv.includes('--sync-seed');
  const missionId = getOptionValue('--mission-id');
  const stage = getOptionValue('--stage');
  if (scope && syncSeed) {
    throw new Error(
      '[SCOPE_CONTEXT_INVALID] tenant intent memory cannot sync into the global governance seed without brokered promotion'
    );
  }
  const paths = resolveIntentContractMemoryPaths(scope);
  const runtimePathOverride = process.env.KYBERION_INTENT_CONTRACT_MEMORY_RUNTIME_PATH?.trim();
  const runtimePath =
    runtimePathOverride && !scope ? pathResolver.rootResolve(runtimePathOverride) : paths.runtime;
  const seedPath = process.env.KYBERION_INTENT_CONTRACT_MEMORY_SEED_PATH?.trim()
    ? pathResolver.rootResolve(process.env.KYBERION_INTENT_CONTRACT_MEMORY_SEED_PATH.trim())
    : paths.seed;
  if (!safeExistsSync(runtimePath)) {
    logger.info('[sync:intent-contract-memory] runtime memory not found; nothing to sync');
    return;
  }

  const runtime = readJson<unknown>(runtimePath);
  validateMemory(runtime);

  const base = safeExistsSync(seedPath)
    ? readJson<unknown>(seedPath)
    : { version: '1.0.0', entries: [] };
  validateMemory(base);

  const seedMemory = base as MemoryFile;
  const runtimeMemory = runtime as MemoryFile;
  const seedMap = new Map<string, MemoryFile['entries'][number]>();
  for (const entry of seedMemory.entries) seedMap.set(entryKey(entry), entry);

  const merged = new Map<string, MemoryFile['entries'][number]>();
  for (const entry of seedMemory.entries) merged.set(entryKey(entry), entry);

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const entry of runtimeMemory.entries) {
    const key = entryKey(entry);
    const previous = seedMap.get(key);
    if (!previous) {
      added += 1;
    } else if (JSON.stringify(previous) !== JSON.stringify(entry)) {
      updated += 1;
    } else {
      unchanged += 1;
    }
    merged.set(key, entry);
  }

  const snapshot: MemoryFile = {
    version: runtimeMemory.version || seedMemory.version || '1.0.0',
    entries: Array.from(merged.values()),
  };
  validateMemory(snapshot);

  if (syncSeed) {
    safeWriteFile(seedPath, JSON.stringify(snapshot, null, 2));
  }
  const report = {
    generated_at: new Date().toISOString(),
    ...(missionId ? { mission_id: missionId.toUpperCase() } : {}),
    ...(stage ? { stage } : {}),
    ...(scope ? { scope } : {}),
    runtime_path: runtimePath,
    governance_seed_path: seedPath,
    seed_sync_applied: syncSeed,
    result: {
      seed_entries_before: seedMemory.entries.length,
      runtime_entries: runtimeMemory.entries.length,
      merged_entries: snapshot.entries.length,
      added,
      updated,
      unchanged,
    },
  };
  safeWriteFile(reportPath, JSON.stringify(report, null, 2));
  if (persistExport) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const exportPath = `${exportDir}/intent-contract-memory-sync-${stamp}.json`;
    try {
      safeWriteFile(exportPath, JSON.stringify(report, null, 2));
    } catch (error) {
      // The report is the authoritative in-workspace result. Export storage
      // may be an offloaded/symlinked volume that is unavailable in a
      // restricted runtime; do not turn a successful sync into a failed
      // lifecycle transition merely because the optional export is blocked.
      logger.warn(
        `[sync:intent-contract-memory] export skipped: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  logger.info(
    `[sync:intent-contract-memory] merged=${snapshot.entries.length} added=${added} updated=${updated} unchanged=${unchanged} report=${reportPath}`
  );
}

main();
