import type { ValidateFunction } from 'ajv';
import * as path from 'node:path';
import { createAjv } from './foundation/ajv.js';
import * as customerResolver from './customer-resolver.js';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
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

const ajv = createAjv();
const SEED_SCHEMA_PATH = pathResolver.knowledge('product/schemas/mission-seed-record.schema.json');
let seedValidateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (seedValidateFn) return seedValidateFn;
  seedValidateFn = compileSchemaFromPath(ajv, SEED_SCHEMA_PATH);
  return seedValidateFn;
}

function seedDir(rootDir = pathResolver.rootDir()): string {
  return path.resolve(rootDir, 'active/shared/runtime/mission-seeds');
}

export function missionSeedRecordPath(seedId: string, rootDir = pathResolver.rootDir()): string {
  return `${seedDir(rootDir)}/${seedId}.json`;
}

function seedDirs(rootDir = pathResolver.rootDir()): string[] {
  const dirs: string[] = [];
  const customerSeedDir = customerResolver.customerRoot('mission-seeds', process.env, rootDir);
  if (customerSeedDir && safeExistsSync(customerSeedDir)) {
    dirs.push(customerSeedDir);
  }
  dirs.push(seedDir(rootDir));
  return dirs;
}

export function validateMissionSeedRecord(value: unknown): value is MissionSeedRecord {
  return Boolean(ensureValidator()(value));
}

export function saveMissionSeedRecord(
  record: MissionSeedRecord,
  options: { rootDir?: string } = {}
): string {
  if (!validateMissionSeedRecord(record)) {
    const errors = (ensureValidator().errors || []).map(
      (error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`
    );
    throw new Error(`Invalid mission seed record: ${errors.join('; ')}`);
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
    const filePath = `${dir}/${seedId}.json`;
    if (!safeExistsSync(filePath)) continue;
    const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw) as MissionSeedRecord;
    if (validateMissionSeedRecord(parsed)) return parsed;
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
