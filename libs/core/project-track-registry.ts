import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from './secure-io.js';

export interface ProjectTrackRecord {
  track_id: string;
  project_id: string;
  name: string;
  summary: string;
  status: 'planned' | 'active' | 'paused' | 'completed' | 'archived';
  track_type:
    'delivery' | 'change' | 'release' | 'incident' | 'compliance' | 'operations' | 'research';
  lifecycle_model:
    | 'sdlc'
    | 'continuous_delivery'
    | 'incident_response'
    | 'continuous_operations'
    | 'research_cycle';
  tier: 'personal' | 'confidential' | 'public';
  tenant_slug?: string;
  primary_locale?: string;
  release_id?: string;
  change_scope?: string;
  gate_profile_id?: string;
  active_missions?: string[];
  required_artifacts?: string[];
  metadata?: Record<string, unknown>;
}

const TRACK_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/project-track-record.schema.json'
);

function trackDir(rootDir = pathResolver.rootDir()): string {
  return path.resolve(rootDir, 'active/shared/runtime/project-tracks');
}

function trackPath(trackId: string, rootDir = pathResolver.rootDir()): string {
  const directory = trackDir(rootDir);
  const candidate = path.resolve(directory, `${trackId}.json`);
  const relative = path.relative(directory, candidate).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`[RESOURCE_PATH_SCOPE] project track path escapes its directory: ${trackId}`);
  }
  return assertSafeRepositoryPath(candidate, {
    allowMissingLeaf: true,
    rootDir,
  });
}

const projectTrackRecordCatalog = defineCatalog<ProjectTrackRecord>({
  id: 'project-track-record',
  path: trackDir,
  schema: TRACK_SCHEMA_PATH,
});

function projectTrackRecordCatalogAtPath(filePath: string) {
  return defineCatalog<ProjectTrackRecord>({
    id: 'project-track-record',
    path: filePath,
    schema: TRACK_SCHEMA_PATH,
  });
}

export function validateProjectTrackRecord(value: unknown): value is ProjectTrackRecord {
  try {
    projectTrackRecordCatalog.validate(value);
    return true;
  } catch {
    return false;
  }
}

export function saveProjectTrackRecord(
  record: ProjectTrackRecord,
  options: { rootDir?: string } = {}
): string {
  const filePath = trackPath(record.track_id, options.rootDir);
  let validated: ProjectTrackRecord;
  try {
    validated = projectTrackRecordCatalogAtPath(filePath).validate(record, filePath);
  } catch (error) {
    throw new Error(
      `Invalid project track record: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const directory = trackDir(options.rootDir);
  if (!safeExistsSync(directory)) safeMkdir(directory, { recursive: true });
  safeWriteFile(filePath, JSON.stringify(validated, null, 2));
  return filePath;
}

export function loadProjectTrackRecord(
  trackId: string,
  options: { rootDir?: string } = {}
): ProjectTrackRecord | null {
  const filePath = trackPath(trackId, options.rootDir);
  if (!safeExistsSync(filePath)) return null;
  try {
    return projectTrackRecordCatalogAtPath(filePath).load();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid catalog ')) return null;
    throw error;
  }
}

export function listProjectTrackRecords(rootDir = pathResolver.rootDir()): ProjectTrackRecord[] {
  const directory = trackDir(rootDir);
  if (!safeExistsSync(directory)) return [];
  return safeReaddir(directory)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadProjectTrackRecord(entry.replace(/\.json$/, ''), { rootDir }))
    .filter((record): record is ProjectTrackRecord => Boolean(record))
    .sort((a, b) => a.track_id.localeCompare(b.track_id));
}

export function listProjectTracksForProject(
  projectId: string,
  options: { rootDir?: string } = {}
): ProjectTrackRecord[] {
  return listProjectTrackRecords(options.rootDir).filter(
    (record) => record.project_id === projectId
  );
}

export function resolveProjectTrackRecordForText(input: {
  projectId?: string;
  utterance?: string;
  trackName?: string;
}): ProjectTrackRecord | null {
  const requestedName = String(input.trackName || '')
    .trim()
    .toLowerCase();
  const utterance = String(input.utterance || '')
    .trim()
    .toLowerCase();
  const candidates = input.projectId
    ? listProjectTracksForProject(input.projectId)
    : listProjectTrackRecords();

  if (requestedName) {
    const exact = candidates.find(
      (record) =>
        record.name.toLowerCase() === requestedName ||
        record.track_id.toLowerCase() === requestedName
    );
    if (exact) return exact;
    const fuzzy = candidates.find(
      (record) =>
        record.name.toLowerCase().includes(requestedName) ||
        requestedName.includes(record.name.toLowerCase()) ||
        record.track_id.toLowerCase().includes(requestedName)
    );
    if (fuzzy) return fuzzy;
  }

  if (!utterance) return null;
  return (
    candidates.find(
      (record) =>
        utterance.includes(record.name.toLowerCase()) ||
        utterance.includes(record.track_id.toLowerCase()) ||
        (record.release_id ? utterance.includes(record.release_id.toLowerCase()) : false)
    ) || null
  );
}
