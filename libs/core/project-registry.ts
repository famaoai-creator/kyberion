import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeReaddir, safeWriteFile } from './secure-io.js';
import { SPECIALIST_IDS } from './specialist-ids.js';

export interface ProjectRecord {
  project_id: string;
  name: string;
  summary: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  tier: 'personal' | 'confidential' | 'public';
  primary_locale?: string;
  repositories?: Array<{
    repo_id: string;
    kind: string;
    default_branch?: string;
    root_path?: string;
  }>;
  service_bindings?: string[];
  vault_refs?: string[];
  active_missions?: string[];
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

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const PROJECT_SCHEMA_PATH = pathResolver.knowledge('public/schemas/project-record.schema.json');
const PROJECT_DIR = pathResolver.shared('runtime/projects');
let projectValidateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (projectValidateFn) return projectValidateFn;
  const raw = safeReadFile(PROJECT_SCHEMA_PATH, { encoding: 'utf8' }) as string;
  projectValidateFn = ajv.compile(JSON.parse(raw));
  return projectValidateFn;
}

function projectPath(projectId: string): string {
  return `${PROJECT_DIR}/${projectId}.json`;
}

export function validateProjectRecord(value: unknown): value is ProjectRecord {
  return Boolean(ensureValidator()(value));
}

export function saveProjectRecord(record: ProjectRecord): string {
  if (!validateProjectRecord(record)) {
    const errors = (ensureValidator().errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`);
    throw new Error(`Invalid project record: ${errors.join('; ')}`);
  }
  if (!safeExistsSync(PROJECT_DIR)) safeMkdir(PROJECT_DIR, { recursive: true });
  const filePath = projectPath(record.project_id);
  safeWriteFile(filePath, JSON.stringify(record, null, 2));
  return filePath;
}

export function loadProjectRecord(projectId: string): ProjectRecord | null {
  const filePath = projectPath(projectId);
  if (!safeExistsSync(filePath)) return null;
  const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(raw) as ProjectRecord;
  return validateProjectRecord(parsed) ? parsed : null;
}

export function listProjectRecords(): ProjectRecord[] {
  if (!safeExistsSync(PROJECT_DIR)) return [];
  return safeReaddir(PROJECT_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadProjectRecord(entry.replace(/\.json$/, '')))
    .filter((record): record is ProjectRecord => Boolean(record))
    .sort((a, b) => a.project_id.localeCompare(b.project_id));
}

export function resolveProjectRecordForText(input: {
  utterance?: string;
  projectName?: string;
}): ProjectRecord | null {
  const requestedName = String(input.projectName || '').trim().toLowerCase();
  const utterance = String(input.utterance || '').trim().toLowerCase();
  const candidates = listProjectRecords();

  if (requestedName) {
    const exact = candidates.find((record) => record.name.toLowerCase() === requestedName || record.project_id.toLowerCase() === requestedName);
    if (exact) return exact;
    const fuzzy = candidates.find((record) =>
      record.name.toLowerCase().includes(requestedName) ||
      requestedName.includes(record.name.toLowerCase()) ||
      record.project_id.toLowerCase().includes(requestedName),
    );
    if (fuzzy) return fuzzy;
  }

  if (!utterance) return null;
  return candidates.find((record) =>
    utterance.includes(record.name.toLowerCase()) ||
    utterance.includes(record.project_id.toLowerCase()),
  ) || null;
}

function slugifyBootstrapToken(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 18) || 'WORK';
}

function inferBootstrapKind(utterance?: string): 'web_service' | 'document_program' | 'general_project' {
  const text = String(utterance || '').toLowerCase();
  if (/(web.?service|webサービス|アプリ|application|saas|サイト)/i.test(text)) return 'web_service';
  if (/(試験計画|報告書|proposal|document|資料|deck|report)/i.test(text)) return 'document_program';
  return 'general_project';
}

export function buildProjectBootstrapWorkItems(input: {
  projectId: string;
  projectName: string;
  utterance?: string;
}): ProjectBootstrapWorkItem[] {
  const prefix = slugifyBootstrapToken(input.projectId.replace(/^PRJ-/, ''));
  const kind = inferBootstrapKind(input.utterance);

  if (kind === 'web_service') {
    return [
      {
        work_id: `WRK-${prefix}-FRAME`,
        kind: 'task_session',
        title: 'Frame the service',
        summary: `${input.projectName} の目的、利用者、主要ユースケースを固める。`,
        status: 'active',
        specialist_id: SPECIALIST_IDS.projectLead,
        outcome_id: 'project_created',
      },
      {
        work_id: `WRK-${prefix}-ARCH`,
        kind: 'mission_seed',
        title: 'Design architecture',
        summary: '情報設計、主要コンポーネント、運用境界を設計する。',
        status: 'planned',
        specialist_id: SPECIALIST_IDS.documentSpecialist,
      },
      {
        work_id: `WRK-${prefix}-BUILD`,
        kind: 'mission_seed',
        title: 'Build the first slice',
        summary: '最小の実装スライスと repository/worktree 戦略を切る。',
        status: 'planned',
        specialist_id: SPECIALIST_IDS.surfaceConcierge,
      },
      {
        work_id: `WRK-${prefix}-VERIFY`,
        kind: 'mission_seed',
        title: 'Verify and launch',
        summary: '試験、運用導線、外部サービス連携を確認する。',
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
        summary: `${input.projectName} の目的、対象読者、必要成果物を整理する。`,
        status: 'active',
        specialist_id: SPECIALIST_IDS.projectLead,
        outcome_id: 'project_created',
      },
      {
        work_id: `WRK-${prefix}-SOURCE`,
        kind: 'mission_seed',
        title: 'Collect source material',
        summary: '利用可能な資料、要件、参照元を集める。',
        status: 'planned',
        specialist_id: SPECIALIST_IDS.knowledgeSpecialist,
      },
      {
        work_id: `WRK-${prefix}-DRAFT`,
        kind: 'mission_seed',
        title: 'Generate the first draft',
        summary: '主要な成果物の初版を生成する。',
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
      summary: `${input.projectName} の目的と成功条件を整理する。`,
      status: 'active',
      specialist_id: SPECIALIST_IDS.projectLead,
      outcome_id: 'project_created',
    },
    {
      work_id: `WRK-${prefix}-PLAN`,
      kind: 'mission_seed',
      title: 'Prepare the first work plan',
      summary: '最初の durable work を切り出し、進め方を決める。',
      status: 'planned',
      specialist_id: SPECIALIST_IDS.surfaceConcierge,
    },
  ];
}
