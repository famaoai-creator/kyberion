import * as AjvModule from 'ajv';
import { compileSchemaFromPath, logger, pathResolver, safeExistsSync, safeWriteFile } from '@agent/core';
import { readJsonFile } from './refactor/cli-input.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true });

const MEMORY_SCHEMA_PATH =
  process.env.KYBERION_INTENT_CONTRACT_MEMORY_SCHEMA_PATH
  || pathResolver.knowledge('public/schemas/intent-contract-memory.schema.json');
const SEED_PATH =
  process.env.KYBERION_INTENT_CONTRACT_MEMORY_SEED_PATH
  || pathResolver.knowledge('public/governance/intent-contract-memory.json');
const RUNTIME_PATH =
  process.env.KYBERION_INTENT_CONTRACT_MEMORY_RUNTIME_PATH
  || pathResolver.shared('runtime/intent-contract-memory.json');
const DEFAULT_REPORT_PATH =
  process.env.KYBERION_INTENT_CONTRACT_MEMORY_REPORT_PATH
  || pathResolver.shared('runtime/reports/intent-contract-memory-sync-latest.json');
const DEFAULT_EXPORT_DIR =
  process.env.KYBERION_INTENT_CONTRACT_MEMORY_EXPORT_DIR
  || pathResolver.shared('exports/intent-contract-memory-sync');

type MemoryFile = {
  version: string;
  entries: Array<{
    intent_id: string;
    contract_ref: { kind: string; ref: string };
  } & Record<string, unknown>>;
};

function readJson<T>(absPath: string): T {
  return readJsonFile(absPath);
}

function validateMemory(value: unknown): asserts value is MemoryFile {
  const validate = compileSchemaFromPath(ajv as any, MEMORY_SCHEMA_PATH);
  if (!validate(value)) {
    const errors = (validate.errors || []).map((e) => `${e.instancePath || '/'} ${e.message || 'schema violation'}`).join('; ');
    throw new Error(`intent-contract-memory schema violation: ${errors}`);
  }
}

function entryKey(entry: { intent_id: string; contract_ref: { kind: string; ref: string } }): string {
  return `${entry.intent_id}::${entry.contract_ref.kind}::${entry.contract_ref.ref}`;
}

function getOptionValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('-')) return undefined;
  return value;
}

function main(): void {
  const reportPath = getOptionValue('--report') || DEFAULT_REPORT_PATH;
  const exportDir = getOptionValue('--export-dir') || DEFAULT_EXPORT_DIR;
  const persistExport = process.argv.includes('--persist-export');
  const syncSeed = process.argv.includes('--sync-seed');
  const missionId = getOptionValue('--mission-id');
  const stage = getOptionValue('--stage');
  if (!safeExistsSync(RUNTIME_PATH)) {
    logger.info('[sync:intent-contract-memory] runtime memory not found; nothing to sync');
    return;
  }

  const runtime = readJson<unknown>(RUNTIME_PATH);
  validateMemory(runtime);

  const base = safeExistsSync(SEED_PATH) ? readJson<unknown>(SEED_PATH) : { version: '1.0.0', entries: [] };
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
    safeWriteFile(SEED_PATH, JSON.stringify(snapshot, null, 2));
  }
  const report = {
    generated_at: new Date().toISOString(),
    ...(missionId ? { mission_id: missionId.toUpperCase() } : {}),
    ...(stage ? { stage } : {}),
    runtime_path: RUNTIME_PATH,
    governance_seed_path: SEED_PATH,
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
    safeWriteFile(exportPath, JSON.stringify(report, null, 2));
  }

  logger.info(
    `[sync:intent-contract-memory] merged=${snapshot.entries.length} added=${added} updated=${updated} unchanged=${unchanged} report=${reportPath}`,
  );
}

main();
