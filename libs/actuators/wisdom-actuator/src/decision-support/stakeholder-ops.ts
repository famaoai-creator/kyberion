import { safeExistsSync, safeReadFile, safeWriteFile, pathResolver } from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';

type StakeholderNode = Record<string, unknown>;

function readJson(path: string): unknown {
  return JSON.parse(safeReadFile(pathResolver.rootResolve(path), { encoding: 'utf8' }) as string);
}

function writeJson(path: string, value: unknown): void {
  safeWriteFile(pathResolver.rootResolve(path), JSON.stringify(value, null, 2));
}

function nowIso(): string {
  return new Date().toISOString();
}

function rank(node: StakeholderNode): number {
  const power = String(node.power_level || node.power || 'low').toLowerCase();
  const interest = String(node.interest_level || node.interest || 'low').toLowerCase();
  if (power === 'high' && interest === 'high') return 0;
  if (power === 'high' && interest === 'low') return 1;
  if (power === 'low' && interest === 'high') return 2;
  return 3;
}

export function stakeholderGridSort(nodes: StakeholderNode[]): StakeholderNode[] {
  return [...nodes].sort((left, right) => rank(left) - rank(right));
}

export function computeReadinessMatrix(input: {
  visits_dir: string;
  proposal_ref?: string;
  deadline?: string;
  output_path: string;
}): {
  readiness_score: number;
  recommendation: 'proceed' | 'delay' | 'redesign';
  written_to: string;
} {
  const directory = pathResolver.rootResolve(input.visits_dir);
  const files = safeExistsSync(directory)
    ? getAllFiles(directory).filter((file) => file.endsWith('.json'))
    : [];
  const visits = files
    .map((file) => {
      try {
        const value: unknown = JSON.parse(safeReadFile(file, { encoding: 'utf8' }) as string);
        return value && typeof value === 'object' ? (value as StakeholderNode) : null;
      } catch {
        return null;
      }
    })
    .filter((visit): visit is StakeholderNode => visit !== null);

  const stanceWeight: Record<string, number> = {
    support: 100,
    conditional: 60,
    neutral: 40,
    oppose: 0,
  };
  const totalWeight = visits.reduce(
    (sum, visit) => sum + (stanceWeight[String(visit.stance)] ?? 30),
    0
  );
  const readinessScore = visits.length === 0 ? 0 : Math.round(totalWeight / visits.length);
  const recommendation =
    readinessScore >= 70 ? 'proceed' : readinessScore >= 40 ? 'delay' : 'redesign';
  const payload = {
    proposal_ref: input.proposal_ref || null,
    deadline: input.deadline || null,
    visits: visits.map((visit) => ({
      person_slug: visit.person_slug,
      visited_at: visit.visited_at,
      stance: visit.stance,
      conditions: visit.conditions || [],
      dissent_signals: visit.dissent_signals || [],
    })),
    readiness_score: readinessScore,
    recommendation,
    generated_at: nowIso(),
  };
  writeJson(input.output_path, payload);
  return { readiness_score: readinessScore, recommendation, written_to: input.output_path };
}

export function recommend(input: { readiness_ref: string; options?: string[] }): {
  choice: string;
  reason: string;
} {
  const matrix = readJson(input.readiness_ref) as StakeholderNode;
  const score = Number(matrix.readiness_score || 0);
  const choice = String(
    matrix.recommendation || (score >= 70 ? 'proceed' : score >= 40 ? 'delay' : 'redesign')
  );
  const allowed = input.options || ['proceed', 'delay', 'redesign'];
  if (!allowed.includes(choice)) {
    return {
      choice: allowed[allowed.length - 1],
      reason: `score ${score} did not map to any allowed option; falling back`,
    };
  }
  return { choice, reason: `readiness_score=${score}` };
}
