export type BrowserDistillCandidateOrigin = 'open_site' | 'conversation_action';

export interface BrowserDistillCandidateActionSummary {
  kind: 'control' | 'capture' | 'apply';
  op: string;
}

export interface BrowserDistillCandidateAssessmentInput {
  origin: BrowserDistillCandidateOrigin;
  goalSummary?: string;
  previewText: string;
  tracePath?: string;
  actionTrailCount: number;
  recentActions?: BrowserDistillCandidateActionSummary[];
  targetUrl?: string;
  windowTitle?: string;
}

export interface BrowserDistillCandidateAssessment {
  eligible: boolean;
  reason: string;
  targetKind: 'pattern';
}

function normalizeText(value: string | undefined): string {
  return String(value || '').trim();
}

function summarizeActionKinds(actions: BrowserDistillCandidateActionSummary[]): {
  applyCount: number;
  captureCount: number;
  controlCount: number;
} {
  return actions.reduce(
    (acc, action) => {
      if (action.kind === 'apply') acc.applyCount += 1;
      if (action.kind === 'capture') acc.captureCount += 1;
      if (action.kind === 'control') acc.controlCount += 1;
      return acc;
    },
    { applyCount: 0, captureCount: 0, controlCount: 0 }
  );
}

export function assessBrowserDistillCandidate(
  input: BrowserDistillCandidateAssessmentInput
): BrowserDistillCandidateAssessment {
  const goalSummary = normalizeText(input.goalSummary);
  const previewText = normalizeText(input.previewText);
  const tracePath = normalizeText(input.tracePath);
  const targetUrl = normalizeText(input.targetUrl);
  const windowTitle = normalizeText(input.windowTitle);
  const recentActions = Array.isArray(input.recentActions) ? input.recentActions : [];
  const summary = summarizeActionKinds(recentActions);

  if (!goalSummary && !previewText) {
    return {
      eligible: false,
      reason: 'Browser workflow has no meaningful summary to reuse.',
      targetKind: 'pattern',
    };
  }
  if (!tracePath) {
    return {
      eligible: false,
      reason: 'Browser workflow has no recorded trace.',
      targetKind: 'pattern',
    };
  }
  if (input.actionTrailCount < 3) {
    return {
      eligible: false,
      reason: 'Browser workflow is too small to promote as a reusable pattern.',
      targetKind: 'pattern',
    };
  }
  if (summary.applyCount === 0) {
    return {
      eligible: false,
      reason: 'Browser workflow has no interactive apply step to learn from.',
      targetKind: 'pattern',
    };
  }
  if (!targetUrl && !windowTitle) {
    return {
      eligible: false,
      reason: 'Browser workflow lacks a concrete target context.',
      targetKind: 'pattern',
    };
  }

  const genericSummary = /^(browser session|operate browser session|opened\b)/i.test(goalSummary);
  const genericPreview = /^Opened\b/i.test(previewText) && summary.applyCount === 0;
  if (genericSummary || genericPreview) {
    return {
      eligible: false,
      reason: 'Browser workflow is still generic and not reusable yet.',
      targetKind: 'pattern',
    };
  }

  if (input.origin === 'open_site' && summary.applyCount === 0) {
    return {
      eligible: false,
      reason: 'Open-site navigation alone is not enough to promote a browser pattern.',
      targetKind: 'pattern',
    };
  }

  return {
    eligible: true,
    reason: 'Browser workflow includes a trace and at least one interactive apply step.',
    targetKind: 'pattern',
  };
}
