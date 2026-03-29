import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeReaddir, safeWriteFile } from './secure-io.js';

export interface ProjectTrackRecord {
  track_id: string;
  project_id: string;
  name: string;
  summary: string;
  status: 'planned' | 'active' | 'paused' | 'completed' | 'archived';
  track_type: 'delivery' | 'change' | 'release' | 'incident' | 'compliance' | 'operations' | 'research';
  lifecycle_model: 'sdlc' | 'continuous_delivery' | 'incident_response' | 'continuous_operations' | 'research_cycle';
  tier: 'personal' | 'confidential' | 'public';
  primary_locale?: string;
  release_id?: string;
  change_scope?: string;
  gate_profile_id?: string;
  active_missions?: string[];
  required_artifacts?: string[];
  metadata?: Record<string, unknown>;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const TRACK_SCHEMA_PATH = pathResolver.knowledge('public/schemas/project-track-record.schema.json');
const TRACK_DIR = pathResolver.shared('runtime/project-tracks');
let trackValidateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (trackValidateFn) return trackValidateFn;
  const raw = safeReadFile(TRACK_SCHEMA_PATH, { encoding: 'utf8' }) as string;
  trackValidateFn = ajv.compile(JSON.parse(raw));
  return trackValidateFn;
}

function trackPath(trackId: string): string {
  return `${TRACK_DIR}/${trackId}.json`;
}

export function validateProjectTrackRecord(value: unknown): value is ProjectTrackRecord {
  return Boolean(ensureValidator()(value));
}

export function saveProjectTrackRecord(record: ProjectTrackRecord): string {
  if (!validateProjectTrackRecord(record)) {
    const errors = (ensureValidator().errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`);
    throw new Error(`Invalid project track record: ${errors.join('; ')}`);
  }
  if (!safeExistsSync(TRACK_DIR)) safeMkdir(TRACK_DIR, { recursive: true });
  const filePath = trackPath(record.track_id);
  safeWriteFile(filePath, JSON.stringify(record, null, 2));
  return filePath;
}

export function loadProjectTrackRecord(trackId: string): ProjectTrackRecord | null {
  const filePath = trackPath(trackId);
  if (!safeExistsSync(filePath)) return null;
  const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(raw) as ProjectTrackRecord;
  return validateProjectTrackRecord(parsed) ? parsed : null;
}

export function listProjectTrackRecords(): ProjectTrackRecord[] {
  if (!safeExistsSync(TRACK_DIR)) return [];
  return safeReaddir(TRACK_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadProjectTrackRecord(entry.replace(/\.json$/, '')))
    .filter((record): record is ProjectTrackRecord => Boolean(record))
    .sort((a, b) => a.track_id.localeCompare(b.track_id));
}

export function listProjectTracksForProject(projectId: string): ProjectTrackRecord[] {
  return listProjectTrackRecords().filter((record) => record.project_id === projectId);
}

export function resolveProjectTrackRecordForText(input: {
  projectId?: string;
  utterance?: string;
  trackName?: string;
}): ProjectTrackRecord | null {
  const requestedName = String(input.trackName || '').trim().toLowerCase();
  const utterance = String(input.utterance || '').trim().toLowerCase();
  const candidates = input.projectId
    ? listProjectTracksForProject(input.projectId)
    : listProjectTrackRecords();

  if (requestedName) {
    const exact = candidates.find((record) => record.name.toLowerCase() === requestedName || record.track_id.toLowerCase() === requestedName);
    if (exact) return exact;
    const fuzzy = candidates.find((record) =>
      record.name.toLowerCase().includes(requestedName) ||
      requestedName.includes(record.name.toLowerCase()) ||
      record.track_id.toLowerCase().includes(requestedName),
    );
    if (fuzzy) return fuzzy;
  }

  if (!utterance) return null;
  return candidates.find((record) =>
    utterance.includes(record.name.toLowerCase()) ||
    utterance.includes(record.track_id.toLowerCase()) ||
    (record.release_id ? utterance.includes(record.release_id.toLowerCase()) : false),
  ) || null;
}
