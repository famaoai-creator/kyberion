/** Server-authored, bounded plan for a continuous operations owner. */
export const CONTINUOUS_MANAGED_WORK_PIPELINE = 'pipelines/continuous-managed-work.json';
export interface ContinuousWorkMission {
  key: string;
  title: string;
  goal: string;
  success_condition: string;
  mission_type?: string;
  depends_on?: string[];
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
      ['key', 'title', 'goal', 'success_condition', 'mission_type', 'depends_on'],
      'mission'
    );
    return {
      key: id(m.key, 'mission key'),
      title: text(m.title, 'mission title', 160),
      goal: text(m.goal, 'mission goal'),
      success_condition: text(m.success_condition, 'success condition'),
      ...(m.mission_type !== undefined ? { mission_type: id(m.mission_type, 'mission type') } : {}),
      ...(m.depends_on !== undefined
        ? { depends_on: ids(m.depends_on, 'mission dependencies') }
        : {}),
    };
  });
  const keys = new Set(missions.map((m) => m.key));
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
