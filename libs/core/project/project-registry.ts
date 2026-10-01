import { t } from '../t.js';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from '../secure-io.js';
import { SPECIALIST_IDS } from '../specialist-ids.js';
import { slugify } from '../foundation/text.js';
import { matchesIntentPhrase } from '../intent/intent-phrase-lexicon.js';

export interface ProjectRecord {
  project_id: string;
  name: string;
  summary: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  tier: 'personal' | 'confidential' | 'public';
  organization_id?: string;
  tenant_slug?: string;
  primary_locale?: string;
  repositories?: Array<{
    repo_id: string;
    kind: string;
    default_branch?: string;
    root_path?: string;
  }>;
  service_bindings?: string[];
  vault_refs?: string[];
  pipeline_refs?: string[];
  active_missions?: string[];
  active_task_sessions?: string[];
  project_os_path?: string;
  default_track_id?: string;
  active_tracks?: string[];
  bootstrap_work_items?: ProjectBootstrapWorkItem[];
  kickoff_task_session_id?: string;
  kickoff_brief?: string;
  kickoff_completed_at?: string;
  proposed_mission_ids?: string[];
  metadata?: Record<string, unknown>;
}

export interface ProjectBootstrapWorkItem {
  work_id: string;
  kind: 'mission_seed' | 'task_session';
  title: string;
  summary: string;
  status: 'planned' | 'active' | 'completed';
  specialist_id: string;
  outcome_id?: string;
}

const PROJECT_SCHEMA_PATH = pathResolver.knowledge('product/schemas/project-record.schema.json');

export function projectRecordPath(projectId: string, rootDir = pathResolver.rootDir()): string {
  const projectDir = path.resolve(rootDir, 'active/shared/runtime/projects');
  const candidate = path.resolve(projectDir, `${projectId}.json`);
  const relative = path.relative(projectDir, candidate).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(
      `[RESOURCE_PATH_SCOPE] project record path escapes its directory: ${projectId}`
    );
  }
  return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true, rootDir });
}

const projectRecordCatalog = defineCatalog<ProjectRecord>({
  id: 'project-record',
  path: () => path.dirname(projectRecordPath('placeholder')),
  schema: PROJECT_SCHEMA_PATH,
});

function projectRecordCatalogAtPath(filePath: string) {
  return defineCatalog<ProjectRecord>({
    id: 'project-record',
    path: filePath,
    schema: PROJECT_SCHEMA_PATH,
  });
}

export function validateProjectRecord(value: unknown): value is ProjectRecord {
  try {
    projectRecordCatalog.validate(value);
    return true;
  } catch {
    return false;
  }
}

export function saveProjectRecord(
  record: ProjectRecord,
  options: { rootDir?: string } = {}
): string {
  const filePath = projectRecordPath(record.project_id, options.rootDir);
  let validated: ProjectRecord;
  try {
    validated = projectRecordCatalogAtPath(filePath).validate(record, filePath);
  } catch (error) {
    throw new Error(
      `Invalid project record: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const projectDir = path.dirname(filePath);
  if (!safeExistsSync(projectDir)) safeMkdir(projectDir, { recursive: true });
  safeWriteFile(filePath, JSON.stringify(validated, null, 2));
  return filePath;
}

export function loadProjectRecord(
  projectId: string,
  options: { rootDir?: string } = {}
): ProjectRecord | null {
  const filePath = projectRecordPath(projectId, options.rootDir);
  if (!safeExistsSync(filePath)) return null;
  try {
    return projectRecordCatalogAtPath(filePath).load();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid catalog ')) return null;
    throw error;
  }
}

export function listProjectRecords(rootDir = pathResolver.rootDir()): ProjectRecord[] {
  return listProjectRecordsAtRoot(rootDir);
}

export function listProjectRecordsAtRoot(rootDir = pathResolver.rootDir()): ProjectRecord[] {
  const projectDir = path.dirname(projectRecordPath('placeholder', rootDir));
  if (!safeExistsSync(projectDir)) return [];
  return safeReaddir(projectDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadProjectRecord(entry.replace(/\.json$/, ''), { rootDir }))
    .filter((record): record is ProjectRecord => Boolean(record))
    .sort((a, b) => a.project_id.localeCompare(b.project_id));
}

export function resolveProjectRecordForText(input: {
  utterance?: string;
  projectName?: string;
}): ProjectRecord | null {
  const requestedName = String(input.projectName || '')
    .trim()
    .toLowerCase();
  const utterance = String(input.utterance || '')
    .trim()
    .toLowerCase();
  const candidates = listProjectRecords();

  if (requestedName) {
    const exact = candidates.find(
      (record) =>
        record.name.toLowerCase() === requestedName ||
        record.project_id.toLowerCase() === requestedName
    );
    if (exact) return exact;
    const fuzzy = candidates.find(
      (record) =>
        record.name.toLowerCase().includes(requestedName) ||
        requestedName.includes(record.name.toLowerCase()) ||
        record.project_id.toLowerCase().includes(requestedName)
    );
    if (fuzzy) return fuzzy;
  }

  if (!utterance) return null;
  return (
    candidates.find(
      (record) =>
        utterance.includes(record.name.toLowerCase()) ||
        utterance.includes(record.project_id.toLowerCase())
    ) || null
  );
}

function inferBootstrapKind(
  utterance?: string
): 'web_service' | 'document_program' | 'general_project' {
  const text = String(utterance || '').toLowerCase();
  if (matchesIntentPhrase(text, 'project.bootstrap_kind_web_service')) return 'web_service';
  if (matchesIntentPhrase(text, 'project.bootstrap_kind_document_program'))
    return 'document_program';
  return 'general_project';
}

export function buildProjectBootstrapWorkItems(input: {
  projectId: string;
  projectName: string;
  utterance?: string;
}): ProjectBootstrapWorkItem[] {
  const prefix = slugify(input.projectId.replace(/^PRJ-/, ''), {
    maxLength: 18,
    fallback: 'work',
  }).toUpperCase();
  const kind = inferBootstrapKind(input.utterance);

  if (kind === 'web_service') {
    return [
      {
        work_id: `WRK-${prefix}-FRAME`,
        kind: 'task_session',
        title: 'Frame the service',
        summary: t('project_ops:bootstrap_web_frame', { project: input.projectName }),
        status: 'active',
        specialist_id: SPECIALIST_IDS.projectLead,
        outcome_id: 'project_created',
      },
      {
        work_id: `WRK-${prefix}-ARCH`,
        kind: 'mission_seed',
        title: 'Design architecture',
        summary: t('project_ops:bootstrap_web_arch'),
        status: 'planned',
        specialist_id: SPECIALIST_IDS.documentSpecialist,
      },
      {
        work_id: `WRK-${prefix}-BUILD`,
        kind: 'mission_seed',
        title: 'Build the first slice',
        summary: t('project_ops:bootstrap_web_build'),
        status: 'planned',
        specialist_id: SPECIALIST_IDS.surfaceConcierge,
      },
      {
        work_id: `WRK-${prefix}-VERIFY`,
        kind: 'mission_seed',
        title: 'Verify and launch',
        summary: t('project_ops:bootstrap_web_verify'),
        status: 'planned',
        specialist_id: SPECIALIST_IDS.serviceOperator,
      },
    ];
  }

  if (kind === 'document_program') {
    return [
      {
        work_id: `WRK-${prefix}-SCOPE`,
        kind: 'task_session',
        title: 'Frame the document scope',
        summary: t('project_ops:bootstrap_doc_scope', { project: input.projectName }),
        status: 'active',
        specialist_id: SPECIALIST_IDS.projectLead,
        outcome_id: 'project_created',
      },
      {
        work_id: `WRK-${prefix}-SOURCE`,
        kind: 'mission_seed',
        title: 'Collect source material',
        summary: t('project_ops:bootstrap_doc_source'),
        status: 'planned',
        specialist_id: SPECIALIST_IDS.knowledgeSpecialist,
      },
      {
        work_id: `WRK-${prefix}-DRAFT`,
        kind: 'mission_seed',
        title: 'Generate the first draft',
        summary: t('project_ops:bootstrap_doc_draft'),
        status: 'planned',
        specialist_id: SPECIALIST_IDS.documentSpecialist,
      },
    ];
  }

  return [
    {
      work_id: `WRK-${prefix}-ALIGN`,
      kind: 'task_session',
      title: 'Frame the project',
      summary: t('project_ops:bootstrap_generic_frame', { project: input.projectName }),
      status: 'active',
      specialist_id: SPECIALIST_IDS.projectLead,
      outcome_id: 'project_created',
    },
    {
      work_id: `WRK-${prefix}-PLAN`,
      kind: 'mission_seed',
      title: 'Prepare the first work plan',
      summary: t('project_ops:bootstrap_generic_plan'),
      status: 'planned',
      specialist_id: SPECIALIST_IDS.surfaceConcierge,
    },
  ];
}
