import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReaddir } from './secure-io.js';
import { listDistillCandidateRecords } from './distill-candidate-registry.js';
import { loadProjectRecord } from './project-registry.js';
import { rankAnalysisRefs } from './analysis-corpus.js';

type Tier = 'personal' | 'confidential' | 'public';

export interface AnalysisIntentSupportInput {
  intentId?: string;
  taskType?: string;
  utterance?: string;
  payload?: Record<string, unknown>;
  requirements?: {
    missing?: string[];
    collected?: Record<string, unknown>;
  };
  projectContext?: {
    project_id?: string;
    project_name?: string;
    track_id?: string;
    track_name?: string;
    tier?: Tier;
  };
}

export interface AnalysisIntentSupport {
  requirements?: {
    missing?: string[];
    collected?: Record<string, unknown>;
  };
  payload?: Record<string, unknown>;
  suggested_refs: string[];
}

export interface ReviewExecutionTargetBinding {
  target_kind: 'pull_request' | 'file' | 'artifact' | 'repository' | 'track' | 'project' | 'unknown';
  review_target: string;
  repository_id?: string;
  repository_root_path?: string;
  target_path?: string;
  pr_number?: number;
  project_id?: string;
  track_id?: string;
}

function inferReviewTarget(input: AnalysisIntentSupportInput): string | undefined {
  if (typeof input.payload?.review_target === 'string' && input.payload.review_target.trim()) {
    return input.payload.review_target.trim();
  }

  const utterance = String(input.utterance || '');
  const artifactMatch = utterance.match(/\b(ART-[A-Z0-9-]+)\b/i);
  if (artifactMatch) return `artifact:${artifactMatch[1].toUpperCase()}`;

  const prMatch = utterance.match(/\b(?:pr|pull request)\s*#?\s*(\d+)\b/i);
  if (prMatch) return `pull_request:${prMatch[1]}`;

  const fileMatch = utterance.match(/\b([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml))\b/);
  if (fileMatch) return `file:${fileMatch[1]}`;

  const projectId = String(input.projectContext?.project_id || '').trim();
  if (projectId) {
    const project = loadProjectRecord(projectId);
    const repositories = Array.isArray(project?.repositories) ? project.repositories : [];
    if (repositories.length === 1 && repositories[0]?.repo_id) {
      return `repository:${repositories[0].repo_id}`;
    }
  }

  const trackId = String(input.projectContext?.track_id || '').trim();
  if (trackId) return `track:${trackId}`;
  if (projectId) return `project:${projectId}`;
  return undefined;
}

function resolveReviewExecutionTargetBinding(input: AnalysisIntentSupportInput, reviewTarget?: string): ReviewExecutionTargetBinding | undefined {
  const normalizedTarget = String(reviewTarget || '').trim();
  if (!normalizedTarget) return undefined;

  const projectId = String(input.projectContext?.project_id || '').trim();
  const trackId = String(input.projectContext?.track_id || '').trim();
  const project = projectId ? loadProjectRecord(projectId) : null;
  const repositories = Array.isArray(project?.repositories) ? project.repositories : [];
  const [kind, rawValue = ''] = normalizedTarget.split(/:(.+)/);

  const base: ReviewExecutionTargetBinding = {
    target_kind: (kind || 'unknown') as ReviewExecutionTargetBinding['target_kind'],
    review_target: normalizedTarget,
    project_id: projectId || undefined,
    track_id: trackId || undefined,
  };

  if (kind === 'repository') {
    const repo = repositories.find((entry) => entry.repo_id === rawValue);
    return {
      ...base,
      target_kind: 'repository',
      repository_id: repo?.repo_id || rawValue || undefined,
      repository_root_path: repo?.root_path,
    };
  }

  if (kind === 'pull_request') {
    const repo = repositories.length === 1 ? repositories[0] : undefined;
    return {
      ...base,
      target_kind: 'pull_request',
      repository_id: repo?.repo_id,
      repository_root_path: repo?.root_path,
      pr_number: Number(rawValue) || undefined,
    };
  }

  if (kind === 'file') {
    const repo = repositories.find((entry) => {
      const rootPath = String(entry.root_path || '').replace(/\/+$/, '');
      return rootPath ? rawValue.startsWith(`${rootPath}/`) || rawValue === rootPath : false;
    }) || (repositories.length === 1 ? repositories[0] : undefined);
    return {
      ...base,
      target_kind: 'file',
      repository_id: repo?.repo_id,
      repository_root_path: repo?.root_path,
      target_path: rawValue || undefined,
    };
  }

  if (kind === 'artifact') {
    return {
      ...base,
      target_kind: 'artifact',
    };
  }

  if (kind === 'track') {
    return {
      ...base,
      target_kind: 'track',
      track_id: rawValue || trackId || undefined,
    };
  }

  if (kind === 'project') {
    return {
      ...base,
      target_kind: 'project',
      project_id: rawValue || projectId || undefined,
    };
  }

  return {
    ...base,
    target_kind: 'unknown',
  };
}

function listIncidentKnowledgeRefs(limit = 5): string[] {
  const incidentsDir = pathResolver.knowledge('public/incidents');
  if (!safeExistsSync(incidentsDir)) return [];
  return safeReaddir(incidentsDir)
    .filter((entry) => entry.endsWith('.md') || entry.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((entry) => `knowledge/public/incidents/${entry}`);
}

function listRelevantDistillRefs(input: {
  projectId?: string;
  trackId?: string;
  limit?: number;
}): string[] {
  const limit = input.limit || 5;
  return listDistillCandidateRecords()
    .filter((candidate) => candidate.status === 'promoted')
    .filter((candidate) => {
      if (input.projectId && candidate.project_id === input.projectId) return true;
      if (input.trackId && candidate.track_id === input.trackId) return true;
      return false;
    })
    .map((candidate) => candidate.promoted_ref)
    .filter((value): value is string => Boolean(value))
    .slice(0, limit);
}

export function buildAnalysisIntentSupport(input: AnalysisIntentSupportInput): AnalysisIntentSupport {
  const missing = new Set(input.requirements?.missing || []);
  const collected = { ...(input.requirements?.collected || {}) };
  const payload = { ...(input.payload || {}) };
  const suggestedRefs = new Set<string>();

  const projectId = String(input.projectContext?.project_id || '').trim();
  const trackId = String(input.projectContext?.track_id || '').trim();

  for (const ref of listRelevantDistillRefs({ projectId, trackId })) suggestedRefs.add(ref);

  if (input.intentId === 'incident-informed-review') {
    for (const ref of listIncidentKnowledgeRefs()) suggestedRefs.add(ref);
    if (missing.has('incident_basis')) {
      payload.incident_basis = payload.incident_basis || 'incident_history';
      collected.incident_basis = 'incident_history';
      missing.delete('incident_basis');
    }
    if (missing.has('review_target')) {
      const reviewTarget = inferReviewTarget(input);
      if (reviewTarget) {
        payload.review_target = reviewTarget;
        collected.review_target = reviewTarget;
        missing.delete('review_target');
      }
    }
  }

  if (input.intentId === 'incident-informed-review') {
    const binding = resolveReviewExecutionTargetBinding(
      input,
      typeof payload.review_target === 'string' ? payload.review_target : undefined,
    );
    if (binding) {
      payload.review_execution_target = binding;
      collected.review_execution_target = binding.review_target;
    }
  }

  if (input.intentId === 'cross-project-remediation') {
    for (const ref of listIncidentKnowledgeRefs(3)) suggestedRefs.add(ref);
    if (missing.has('source_corpus') && payload.source_corpus) {
      collected.source_corpus = payload.source_corpus;
      missing.delete('source_corpus');
    }
    if (missing.has('target_scope') && projectId) {
      const targetScope = trackId ? `project:${projectId}/track:${trackId}` : `project:${projectId}`;
      payload.target_scope = targetScope;
      collected.target_scope = targetScope;
      missing.delete('target_scope');
    }
  }

  const rankedRefs = rankAnalysisRefs({
    refs: Array.from(suggestedRefs),
    projectId,
    trackId,
    reviewTarget: typeof payload.review_target === 'string' ? payload.review_target : undefined,
    targetScope: typeof payload.target_scope === 'string' ? payload.target_scope : undefined,
    utterance: input.utterance,
  }).slice(0, 8);

  if (rankedRefs.length > 0) {
    payload.suggested_refs = rankedRefs;
  }

  return {
    requirements: {
      missing: [...missing],
      collected,
    },
    payload,
    suggested_refs: rankedRefs,
  };
}
