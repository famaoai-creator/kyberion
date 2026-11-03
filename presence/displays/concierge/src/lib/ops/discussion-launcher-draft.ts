import type { DiscussionEngineChoice, DiscussionRunFormat } from './discussion-run-contract';

export interface DiscussionLauncherDraft {
  goal: string;
  tempo: 'fast' | 'normal' | 'slow';
  speaker: DiscussionEngineChoice;
  format: DiscussionRunFormat;
  missionId: string;
}

type Params = Pick<URLSearchParams, 'getAll'>;
/** A retention boundary only. Server scope remains the authority for execution. */
export function discussionDraftContext(params: Params): string {
  return JSON.stringify(
    ['tenant', 'organization_id', 'project_id', 'mission', 'mission_id', 'goal'].map((key) =>
      params.getAll(key)
    )
  );
}

export function emptyDiscussionDraft(): DiscussionLauncherDraft {
  return { goal: '', tempo: 'normal', speaker: 'scripted', format: 'brief', missionId: '' };
}

/** Seed only the first page entry, never after a scope change. */
export function initialDiscussionDraft(params: Params): DiscussionLauncherDraft {
  return {
    ...emptyDiscussionDraft(),
    goal: (params.getAll('goal')[0] ?? '').slice(0, 2000),
    missionId: params.getAll('mission')[0] ?? '',
  };
}
