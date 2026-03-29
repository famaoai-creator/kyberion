import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeReaddir, safeWriteFile } from './secure-io.js';
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

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const SEED_SCHEMA_PATH = pathResolver.knowledge('public/schemas/mission-seed-record.schema.json');
const SEED_DIR = pathResolver.shared('runtime/mission-seeds');
let seedValidateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (seedValidateFn) return seedValidateFn;
  seedValidateFn = compileSchemaFromPath(ajv, SEED_SCHEMA_PATH);
  return seedValidateFn;
}

function seedPath(seedId: string): string {
  return `${SEED_DIR}/${seedId}.json`;
}

export function validateMissionSeedRecord(value: unknown): value is MissionSeedRecord {
  return Boolean(ensureValidator()(value));
}

export function saveMissionSeedRecord(record: MissionSeedRecord): string {
  if (!validateMissionSeedRecord(record)) {
    const errors = (ensureValidator().errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`);
    throw new Error(`Invalid mission seed record: ${errors.join('; ')}`);
  }
  if (!safeExistsSync(SEED_DIR)) safeMkdir(SEED_DIR, { recursive: true });
  const filePath = seedPath(record.seed_id);
  safeWriteFile(filePath, JSON.stringify(record, null, 2));
  return filePath;
}

export function loadMissionSeedRecord(seedId: string): MissionSeedRecord | null {
  const filePath = seedPath(seedId);
  if (!safeExistsSync(filePath)) return null;
  const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(raw) as MissionSeedRecord;
  return validateMissionSeedRecord(parsed) ? parsed : null;
}

export function listMissionSeedRecords(): MissionSeedRecord[] {
  if (!safeExistsSync(SEED_DIR)) return [];
  return safeReaddir(SEED_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadMissionSeedRecord(entry.replace(/\.json$/, '')))
    .filter((record): record is MissionSeedRecord => Boolean(record))
    .sort((a, b) => a.seed_id.localeCompare(b.seed_id));
}
