import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import * as customerResolver from './customer-resolver.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from './secure-io.js';
import type { OrganizationWorkLoopSummary } from './work-design.js';

export interface MissionSeedRecord {
  seed_id: string;
  project_id: string;
  track_id?: string;
  track_name?: string;
  source_task_session_id?: string;
  source_work_id?: string;
  title: string;
  summary: string;
  status: 'proposed' | 'ready' | 'promoted' | 'archived';
  specialist_id: string;
  outcome_id?: string;
  mission_type_hint?: string;
  locale?: string;
  work_loop?: OrganizationWorkLoopSummary;
  promoted_mission_id?: string;
  created_at: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

const SEED_SCHEMA_PATH = pathResolver.knowledge('product/schemas/mission-seed-record.schema.json');

function seedDir(rootDir = pathResolver.rootDir()): string {
  return assertSafeRepositoryPath(path.resolve(rootDir, 'active/shared/runtime/mission-seeds'), {
    allowMissingLeaf: true,
  });
}

function normalizeSeedId(seedId: string): string {
  const normalized = String(seedId || '').trim();
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/]/u.test(normalized)) {
    throw new Error(`[mission-seed-registry] invalid seed id: ${seedId}`);
  }
  return normalized;
}

function seedRecordPathInDirectory(directory: string, seedId: string): string {
  return assertSafeRepositoryPath(`${directory}/${normalizeSeedId(seedId)}.json`, {
    allowMissingLeaf: true,
  });
}

export function missionSeedRecordPath(seedId: string, rootDir = pathResolver.rootDir()): string {
  return seedRecordPathInDirectory(seedDir(rootDir), seedId);
}

const missionSeedRecordCatalog = defineCatalog<MissionSeedRecord>({
  id: 'mission-seed-record',
  path: seedDir,
  schema: SEED_SCHEMA_PATH,
});

function seedDirs(rootDir = pathResolver.rootDir()): string[] {
  const dirs: string[] = [];
  const customerSeedDir = customerResolver.customerRoot('mission-seeds', process.env, rootDir);
  if (customerSeedDir) {
    try {
      const safeCustomerSeedDir = assertSafeRepositoryPath(customerSeedDir, {
        allowMissingLeaf: true,
      });
      if (safeExistsSync(safeCustomerSeedDir)) dirs.push(safeCustomerSeedDir);
    } catch {
      // An unsafe customer overlay is ignored rather than merged into the registry.
    }
  }
  dirs.push(seedDir(rootDir));
  return dirs;
}

export function validateMissionSeedRecord(value: unknown): value is MissionSeedRecord {
  try {
    missionSeedRecordCatalog.validate(value);
    return true;
  } catch {
    return false;
  }
}

export function saveMissionSeedRecord(
  record: MissionSeedRecord,
  options: { rootDir?: string } = {}
): string {
  try {
    missionSeedRecordCatalog.validate(record);
  } catch (error) {
    throw new Error(
      `Invalid mission seed record: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const directory = seedDir(options.rootDir || pathResolver.rootDir());
  if (!safeExistsSync(directory)) safeMkdir(directory, { recursive: true });
  const filePath = missionSeedRecordPath(record.seed_id, options.rootDir || pathResolver.rootDir());
  safeWriteFile(filePath, JSON.stringify(record, null, 2));
  return filePath;
}

export function loadMissionSeedRecord(
  seedId: string,
  options: { rootDir?: string } = {}
): MissionSeedRecord | null {
  for (const dir of seedDirs(options.rootDir || pathResolver.rootDir())) {
    let filePath: string;
    try {
      filePath = seedRecordPathInDirectory(dir, seedId);
    } catch {
      continue;
    }
    if (!safeExistsSync(filePath)) continue;
    try {
      return defineCatalog<MissionSeedRecord>({
        id: 'mission-seed-record',
        path: filePath,
        schema: SEED_SCHEMA_PATH,
      }).load();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Invalid catalog ')) continue;
      throw error;
    }
  }
  return null;
}

export function listMissionSeedRecords(options: { rootDir?: string } = {}): MissionSeedRecord[] {
  const seen = new Set<string>();
  const records: MissionSeedRecord[] = [];

  for (const dir of seedDirs(options.rootDir || pathResolver.rootDir())) {
    if (!safeExistsSync(dir)) continue;
    for (const entry of safeReaddir(dir).filter((item) => item.endsWith('.json'))) {
      const seedId = entry.replace(/\.json$/, '');
      if (seen.has(seedId)) continue;
      const record = loadMissionSeedRecord(seedId, options);
      if (!record) continue;
      seen.add(seedId);
      records.push(record);
    }
  }

  return records.sort((a, b) => a.seed_id.localeCompare(b.seed_id));
}
