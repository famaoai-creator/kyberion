export interface TaskDistillCandidateAssessmentInput {
  taskType: string;
  goalSummary?: string;
  previewText: string;
  artifactId: string;
  hasWorkLoop: boolean;
  bootstrapKind?: string;
}

export interface TaskDistillCandidateAssessment {
  eligible: boolean;
  reason: string;
  targetKind: 'pattern' | 'sop_candidate' | 'knowledge_hint' | 'report_template';
}

function normalizeText(value: string | undefined): string {
  return String(value || '').trim();
}

function isGenericPresentationOrReport(goalSummary: string, previewText: string): boolean {
  const normalizedGoal = goalSummary.toLowerCase();
  const normalizedPreview = previewText.toLowerCase();
  return (
    /^(create|make|generate)\s+(a\s+)?(deck|presentation|report|workbook)$/i.test(goalSummary) ||
    /^PowerPoint 資料を生成しました。?$/.test(previewText) ||
    /^レポート文書を生成しました。?$/.test(previewText) ||
    normalizedGoal === 'create a deck' ||
    normalizedGoal === 'generate a report' ||
    normalizedGoal === 'create a report' ||
    normalizedPreview === 'powerpoint 資料を生成しました。'.toLowerCase() ||
    normalizedPreview === 'レポート文書を生成しました。'.toLowerCase()
  );
}

export function assessTaskDistillCandidate(
  input: TaskDistillCandidateAssessmentInput
): TaskDistillCandidateAssessment {
  const goalSummary = normalizeText(input.goalSummary);
  const previewText = normalizeText(input.previewText);
  const taskType = normalizeText(input.taskType);
  const artifactId = normalizeText(input.artifactId);

  if (!artifactId) {
    return {
      eligible: false,
      reason: 'Task session has no artifact to anchor reuse.',
      targetKind: 'knowledge_hint',
    };
  }
  if (!input.hasWorkLoop) {
    return {
      eligible: false,
      reason: 'Task session has no governed work loop.',
      targetKind: 'knowledge_hint',
    };
  }
  if (!goalSummary && !previewText) {
    return {
      eligible: false,
      reason: 'Task session has no meaningful summary to reuse.',
      targetKind: 'knowledge_hint',
    };
  }

  if (taskType === 'analysis') {
    if (input.bootstrapKind === 'project_bootstrap') {
      return {
        eligible: true,
        reason: 'Project bootstrap analysis is reusable as a governed pattern.',
        targetKind: 'pattern',
      };
    }
    return {
      eligible: false,
      reason: 'General analysis output is too broad to promote automatically.',
      targetKind: 'knowledge_hint',
    };
  }

  if (taskType === 'service_operation') {
    if (previewText.length < 8 && goalSummary.length < 8) {
      return {
        eligible: false,
        reason: 'Service operation lacks concrete operational detail.',
        targetKind: 'sop_candidate',
      };
    }
    return {
      eligible: true,
      reason: 'Service operation exposes a concrete operational flow worth learning.',
      targetKind: 'sop_candidate',
    };
  }

  if (
    taskType === 'presentation_deck' ||
    taskType === 'report_document' ||
    taskType === 'workbook_wbs'
  ) {
    if (isGenericPresentationOrReport(goalSummary, previewText) && goalSummary.length < 12) {
      return {
        eligible: false,
        reason: 'Document output is still too generic to promote safely.',
        targetKind: taskType === 'report_document' ? 'report_template' : 'pattern',
      };
    }
    return {
      eligible: true,
      reason: 'Document workflow has a reusable structure and governed artifact.',
      targetKind: taskType === 'report_document' ? 'report_template' : 'pattern',
    };
  }

  return {
    eligible: false,
    reason: `Task type ${taskType || 'unknown'} is not promoted automatically.`,
    targetKind: 'knowledge_hint',
  };
}
