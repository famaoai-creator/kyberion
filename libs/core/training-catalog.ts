import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  assertSafeRepositoryPath,
} from './secure-io.js';
import { isValidMemberId } from './member-registry.js';
import { isValidTenantSlug } from './entity-scope.js';

export type TrainingStatus = 'not_started' | 'in_progress' | 'complete';
export interface TrainingLesson {
  id: string;
  title: string;
  goal: string;
  try: { kind: 'ask' | 'decide' | 'progress' | 'settings'; prefill?: string };
  check: { kind: 'self' | 'artifact' | 'decision'; text: string };
}
export interface TrainingTrack {
  id: string;
  level: 'beginner' | 'intermediate' | 'advanced';
  title: string;
  audience: string;
  lessons: TrainingLesson[];
}
export interface TrainingCatalog {
  version: string;
  tracks: TrainingTrack[];
}
export interface TrainingProgress {
  version: string;
  member_id: string;
  lessons: Record<string, { status: TrainingStatus; completed_at?: string; evidence?: string }>;
}
export interface TrainingAssignment {
  member_id: string;
  track_id: string;
  status: TrainingStatus;
  assigned_at?: string;
}
export interface TrainingAssignments {
  version: string;
  tenant_slug: string;
  assignments: TrainingAssignment[];
}

const catalog = defineCatalog<TrainingCatalog>({
  id: 'training-catalog',
  path: pathResolver.rootResolve('knowledge/product/orchestration/training-catalog.json'),
  schema: pathResolver.rootResolve('knowledge/product/schemas/training-catalog.schema.json'),
});
const PROGRESS_SCHEMA = pathResolver.rootResolve(
  'knowledge/product/schemas/training-progress.schema.json'
);
const ASSIGNMENTS_SCHEMA = pathResolver.rootResolve(
  'knowledge/product/schemas/training-assignments.schema.json'
);

export function loadTrainingCatalog(): TrainingCatalog {
  return catalog.load();
}
export function findTrainingTrack(id: string): TrainingTrack | undefined {
  return loadTrainingCatalog().tracks.find((track) => track.id === id);
}
function validate<T>(value: unknown, id: string, schema: string): T {
  return defineCatalog<T>({ id, path: schema, schema }).validate(value) as T;
}
function readObject<T>(file: string, fallback: T, id: string, schema: string): T {
  const safe = assertSafeRepositoryPath(file, { allowMissingLeaf: true });
  if (!safeExistsSync(safe)) return fallback;
  return validate(
    parseSafeJsonInput(String(safeReadFile(safe, { encoding: 'utf8' })), id),
    id,
    schema
  );
}
function writeObject<T>(file: string, value: T, id: string, schema: string): T {
  const validated = validate<T>(value, id, schema);
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8' });
  return validated;
}
export function trainingProgressPath(memberId: string): string {
  if (!isValidMemberId(memberId)) throw new Error('invalid member id');
  return path.join(pathResolver.rootDir(), 'knowledge/personal/members', memberId, 'training.json');
}
export function readTrainingProgress(memberId: string): TrainingProgress {
  return readObject(
    trainingProgressPath(memberId),
    { version: '1.0.0', member_id: memberId, lessons: {} },
    `training progress ${memberId}`,
    PROGRESS_SCHEMA
  );
}
export function writeTrainingProgress(value: TrainingProgress): TrainingProgress {
  return writeObject(
    trainingProgressPath(value.member_id),
    value,
    `training progress ${value.member_id}`,
    PROGRESS_SCHEMA
  );
}
export function trainingAssignmentsPath(tenantSlug: string): string {
  if (!isValidTenantSlug(tenantSlug)) throw new Error('invalid tenant slug');
  return path.join(
    pathResolver.rootDir(),
    'knowledge/confidential',
    tenantSlug,
    'training/assignments.json'
  );
}
export function readTrainingAssignments(tenantSlug: string): TrainingAssignments {
  return readObject(
    trainingAssignmentsPath(tenantSlug),
    { version: '1.0.0', tenant_slug: tenantSlug, assignments: [] },
    `training assignments ${tenantSlug}`,
    ASSIGNMENTS_SCHEMA
  );
}
export interface TrainingProgressSummary {
  member_id: string;
  assignment?: { track_id: string; status: TrainingStatus };
  lessons_done: number;
  lessons_total: number;
  last_completed_at?: string;
}

/**
 * HT-05 second pass: pure summary of every member's training standing —
 * catalog lesson totals + each member's own progress record — for the
 * per-member progress overview a route/handler then joins with display
 * names and member ids to keep this function free of member-registry I/O.
 * `progressByMember`'s keys are exactly the member set to summarize (the
 * caller filters to the tenant-narrowed membership before calling this), so
 * a member with no lessons started still appears with zeroed counts. When a
 * member carries more than one assignment, the most recently assigned one
 * wins (ties broken by catalog order).
 */
export function summarizeTrainingProgress(
  catalog: TrainingCatalog,
  assignments: TrainingAssignment[],
  progressByMember: Record<string, TrainingProgress>
): TrainingProgressSummary[] {
  const lessonsTotal = catalog.tracks.reduce((sum, track) => sum + track.lessons.length, 0);
  return Object.entries(progressByMember).map(([member_id, progress]) => {
    const lessonEntries = Object.values(progress.lessons);
    const lessonsDone = lessonEntries.filter((lesson) => lesson.status === 'complete').length;
    const completedAts = lessonEntries
      .filter((lesson) => lesson.status === 'complete' && lesson.completed_at)
      .map((lesson) => lesson.completed_at as string)
      .sort();
    const lastCompletedAt = completedAts[completedAts.length - 1];
    const memberAssignments = assignments
      .filter((item) => item.member_id === member_id)
      .sort((a, b) => (a.assigned_at ?? '').localeCompare(b.assigned_at ?? ''));
    const assignment = memberAssignments[memberAssignments.length - 1];
    return {
      member_id,
      ...(assignment
        ? { assignment: { track_id: assignment.track_id, status: assignment.status } }
        : {}),
      lessons_done: lessonsDone,
      lessons_total: lessonsTotal,
      ...(lastCompletedAt ? { last_completed_at: lastCompletedAt } : {}),
    };
  });
}

export function upsertTrainingAssignment(
  tenantSlug: string,
  memberId: string,
  trackId: string
): TrainingAssignments {
  if (!isValidMemberId(memberId) || !findTrainingTrack(trackId))
    throw new Error('invalid training assignment');
  const current = readTrainingAssignments(tenantSlug);
  const assignments = current.assignments.filter(
    (item) => !(item.member_id === memberId && item.track_id === trackId)
  );
  assignments.push({
    member_id: memberId,
    track_id: trackId,
    status: 'not_started',
    assigned_at: nowIso(),
  });
  return writeObject(
    trainingAssignmentsPath(tenantSlug),
    { ...current, assignments },
    `training assignments ${tenantSlug}`,
    ASSIGNMENTS_SCHEMA
  );
}
