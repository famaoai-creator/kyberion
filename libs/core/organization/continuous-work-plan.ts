/** Server-authored, bounded plan for a continuous operations owner. */
import type { MissionDevelopmentSpec } from '../mission/mission-development-continuation.js';
import { parseExternalOperationGrant } from '../governance/external-operation-target.js';
import {
  TASK_SOURCE_ROOTS,
  validateTaskSourcePaths,
} from '../foundation/task-tool-grant-validation.js';

export const CONTINUOUS_MANAGED_WORK_PIPELINE = 'pipelines/continuous-managed-work.json';
export interface ContinuousWorkMission {
  key: string;
  title: string;
  goal: string;
  success_condition: string;
  mission_type?: string;
  depends_on?: string[];
  development?: MissionDevelopmentSpec;
}
export interface ContinuousWorkPlan {
  kind: 'project' | 'mission' | 'mission_group';
  project?: { name: string; summary: string; objective_ids?: string[] };
  missions: ContinuousWorkMission[];
}
function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !keys.includes(key)))
    throw new Error(`${label} contains unknown fields`);
  return row;
}
function text(value: unknown, label: string, max = 4000): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    throw new Error(`Invalid ${label}`);
  return value.trim();
}
function id(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(result)) throw new Error(`Invalid ${label}`);
  return result;
}
function ids(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error(`Invalid ${label}`);
  const result = value.map((entry) => id(entry, label));
  if (new Set(result).size !== result.length) throw new Error(`Duplicate ${label}`);
  return result;
}
function relativePath(value: unknown, label: string, allowRoot = false): string {
  const result = text(value, label, 1024);
  if (allowRoot && result === '.') return result;
  if (
    !/^[A-Za-z0-9_./-]+$/.test(result) ||
    result.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Invalid ${label}`);
  return result;
}
function development(value: unknown): MissionDevelopmentSpec {
  const d = object(
    value,
    [
      'cwd',
      'repository_url',
      'source_edit_paths',
      'implementation_task_id',
      'review_task_id',
      'title',
      'body_file',
      'max_repairs',
    ],
    'mission development'
  );
  const implementation = id(d.implementation_task_id, 'implementation task id');
  if (d.cwd !== '.') throw new Error('Development owner requires its dedicated checkout root');
  if (
    !Array.isArray(d.source_edit_paths) ||
    d.source_edit_paths.length < 1 ||
    new Set(d.source_edit_paths).size !== d.source_edit_paths.length ||
    d.source_edit_paths.some(
      (entry) =>
        typeof entry !== 'string' ||
        !/^[A-Za-z0-9_./-]+$/.test(entry) ||
        !TASK_SOURCE_ROOTS.some((root) => entry.startsWith(root))
    )
  )
    throw new Error('Development source edit paths must name 1..64 unique exact public code files');
  const target = parseExternalOperationGrant({
    operation_id: 'vcs:pr_create',
    repository: d.repository_url,
  });
  if (!target || !('repository' in target)) throw new Error('Invalid development repository URL');
  const review = id(d.review_task_id, 'review task id');
  if (implementation === review) throw new Error('Development review must be independent');
  const body = relativePath(d.body_file, 'development body file');
  if (!body.startsWith('evidence/')) throw new Error('Development body must be mission evidence');
  if (
    d.max_repairs !== undefined &&
    (!Number.isSafeInteger(d.max_repairs) || Number(d.max_repairs) < 0 || Number(d.max_repairs) > 3)
  )
    throw new Error('Invalid development repair limit');
  return {
    cwd: relativePath(d.cwd, 'development repository path', true),
    repository_url: target.repository,
    source_edit_paths: validateTaskSourcePaths(d.source_edit_paths),
    implementation_task_id: implementation,
    review_task_id: review,
    title: text(d.title, 'development PR title', 160),
    body_file: body,
    ...(d.max_repairs !== undefined ? { max_repairs: Number(d.max_repairs) } : {}),
  };
}
export function parseContinuousWorkPlan(value: unknown): ContinuousWorkPlan {
  const row = object(value, ['kind', 'project', 'missions'], 'continuous work');
  if (!['project', 'mission', 'mission_group'].includes(String(row.kind)))
    throw new Error('Invalid continuous work kind');
  if (!Array.isArray(row.missions) || row.missions.length < 1 || row.missions.length > 16)
    throw new Error('Continuous work requires 1..16 missions');
  if (row.kind === 'mission' && row.missions.length !== 1)
    throw new Error('mission kind requires one mission');
  if ((row.kind === 'project') !== (row.project !== undefined))
    throw new Error('project definition is required only for project kind');
  const missions = row.missions.map((value): ContinuousWorkMission => {
    const m = object(
      value,
      ['key', 'title', 'goal', 'success_condition', 'mission_type', 'depends_on', 'development'],
      'mission'
    );
    if (
      m.development !== undefined &&
      m.mission_type !== undefined &&
      m.mission_type !== 'development'
    )
      throw new Error('Development continuation requires the development mission process');
    return {
      key: id(m.key, 'mission key'),
      title: text(m.title, 'mission title', 160),
      goal: text(m.goal, 'mission goal'),
      success_condition: text(m.success_condition, 'success condition'),
      ...(m.mission_type !== undefined ? { mission_type: id(m.mission_type, 'mission type') } : {}),
      ...(m.depends_on !== undefined
        ? { depends_on: ids(m.depends_on, 'mission dependencies') }
        : {}),
      ...(m.development !== undefined ? { development: development(m.development) } : {}),
    };
  });
  const keys = new Set(missions.map((m) => m.key));
  if (missions.filter((mission) => mission.development).length > 1)
    throw new Error('Continuous work supports one development mission per dedicated checkout');
  if (keys.size !== missions.length) throw new Error('Duplicate mission key');
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error('Cyclic mission dependencies');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dep of missions.find((m) => m.key === key)!.depends_on ?? []) {
      if (!keys.has(dep)) throw new Error('Unknown mission dependency');
      visit(dep);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of keys) visit(key);
  let project: ContinuousWorkPlan['project'];
  if (row.project !== undefined) {
    const p = object(row.project, ['name', 'summary', 'objective_ids'], 'project');
    project = {
      name: text(p.name, 'project name', 160),
      summary: text(p.summary, 'project summary'),
      ...(p.objective_ids !== undefined
        ? { objective_ids: ids(p.objective_ids, 'objective ids') }
        : {}),
    };
  }
  return {
    kind: row.kind as ContinuousWorkPlan['kind'],
    ...(project ? { project } : {}),
    missions: [...visited].map((key) => missions.find((mission) => mission.key === key)!),
  };
}
