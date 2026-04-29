export interface MissionMemoryCandidateAssessmentInput {
  missionId: string;
  missionType?: string;
  summary?: string;
  evidenceCount: number;
  tier: 'personal' | 'confidential' | 'public';
}

export interface MissionMemoryCandidateAssessment {
  eligible: boolean;
  reason: string;
  proposedKind: 'sop' | 'template' | 'heuristic' | 'risk_rule' | 'clarification_prompt';
}

export interface MissionSeedAssessmentInput {
  projectId?: string;
  missionTypeHint?: string;
  title?: string;
  summary?: string;
  sourceTaskSessionId?: string;
  sourceWorkId?: string;
  status?: 'proposed' | 'ready' | 'promoted' | 'archived';
}

export interface MissionSeedAssessment {
  eligible: boolean;
  reason: string;
  shouldPromote: boolean;
}

function normalizeText(value?: string): string {
  return String(value || '').trim();
}

function inferMissionMemoryKind(
  missionType?: string
): MissionMemoryCandidateAssessment['proposedKind'] {
  const normalized = normalizeText(missionType).toLowerCase();
  if (normalized.includes('incident') || normalized.includes('risk')) return 'risk_rule';
  if (normalized.includes('report') || normalized.includes('template')) return 'template';
  if (normalized.includes('research') || normalized.includes('analysis'))
    return 'clarification_prompt';
  if (normalized.includes('bootstrap') || normalized.includes('project')) return 'heuristic';
  return 'sop';
}

export function assessMissionMemoryCandidate(
  input: MissionMemoryCandidateAssessmentInput
): MissionMemoryCandidateAssessment {
  const missionType = normalizeText(input.missionType);
  const summary = normalizeText(input.summary);
  if (!input.missionId.trim()) {
    return {
      eligible: false,
      reason: 'Mission candidate is missing a mission id.',
      proposedKind: 'heuristic',
    };
  }
  if (input.evidenceCount === 0) {
    return {
      eligible: false,
      reason: 'Mission candidate has no evidence.',
      proposedKind: inferMissionMemoryKind(missionType),
    };
  }
  if (!summary) {
    return {
      eligible: false,
      reason: 'Mission candidate has no summary to reuse.',
      proposedKind: inferMissionMemoryKind(missionType),
    };
  }
  if (summary.length < 12) {
    return {
      eligible: false,
      reason: 'Mission candidate summary is too thin for reuse.',
      proposedKind: inferMissionMemoryKind(missionType),
    };
  }
  if (input.tier === 'public' && /confidential|personal/i.test(summary)) {
    return {
      eligible: false,
      reason: 'Public mission candidate summary appears restricted.',
      proposedKind: inferMissionMemoryKind(missionType),
    };
  }
  return {
    eligible: true,
    reason: 'Mission candidate has evidence and a reusable summary.',
    proposedKind: inferMissionMemoryKind(missionType),
  };
}

export function assessMissionSeedCandidate(
  input: MissionSeedAssessmentInput
): MissionSeedAssessment {
  const title = normalizeText(input.title);
  const summary = normalizeText(input.summary);
  if (!normalizeText(input.projectId)) {
    return {
      eligible: false,
      reason: 'Mission seed is missing a project id.',
      shouldPromote: false,
    };
  }
  if (!title || !summary) {
    return {
      eligible: false,
      reason: 'Mission seed is missing a reusable title or summary.',
      shouldPromote: false,
    };
  }
  if (title.length < 6 || summary.length < 12) {
    return {
      eligible: false,
      reason: 'Mission seed text is too thin to be useful.',
      shouldPromote: false,
    };
  }

  const sourceLinked = Boolean(
    normalizeText(input.sourceTaskSessionId) || normalizeText(input.sourceWorkId)
  );
  const bootstrapHint =
    /bootstrap|kickoff|seed|architecture|implementation|verification|analysis/i.test(
      normalizeText(input.missionTypeHint) || `${title} ${summary}`
    );
  return {
    eligible: sourceLinked && bootstrapHint,
    reason:
      sourceLinked && bootstrapHint
        ? 'Mission seed is linked to source work and has a concrete bootstrap hint.'
        : 'Mission seed lacks a strong source linkage or bootstrap hint.',
    shouldPromote: Boolean(sourceLinked && bootstrapHint && input.status === 'promoted'),
  };
}
