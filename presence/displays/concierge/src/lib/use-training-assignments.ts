'use client';

import * as React from 'react';
import { frontDeskText, type ConciergeLocale } from './i18n';
import {
  parseTrainingAssignmentsResponse,
  parseTrainingCatalogResponse,
  parseTrainingProgressOverviewResponse,
  type Notice,
  type TrainingAssignments,
  type TrainingProgressSummary,
  type TrainingTrack,
} from './settings-types';

/**
 * HT-05 組織とメンバー 研修 pane — lists tracks from the governed catalog
 * (/api/training/catalog, read-only) and lets an owner assign one to a
 * member (/api/training/assignments). Split out of settings/page.tsx into
 * its own hook (same posture as use-voice-selection.ts) to stay under the KP
 * max-file-lines gate. Optional data: every failure degrades silently.
 */
export interface UseTrainingAssignmentsResult {
  trainingTracks: TrainingTrack[];
  trainingAssignments: TrainingAssignments[];
  trainingProgress: TrainingProgressSummary[];
  trainingTrackId: string;
  setTrainingTrackId: (value: string) => void;
  refreshTrainingCatalog: () => Promise<void>;
  refreshTrainingAssignments: () => Promise<void>;
  refreshTrainingProgress: () => Promise<void>;
  assignTraining: (memberId: string, tenantSlug: string | undefined) => Promise<void>;
}

export function useTrainingAssignments(
  locale: ConciergeLocale,
  setNotice: (notice: Notice) => void
): UseTrainingAssignmentsResult {
  const [trainingTracks, setTrainingTracks] = React.useState<TrainingTrack[]>([]);
  const [trainingAssignments, setTrainingAssignments] = React.useState<TrainingAssignments[]>([]);
  const [trainingProgress, setTrainingProgress] = React.useState<TrainingProgressSummary[]>([]);
  const [trainingTrackId, setTrainingTrackId] = React.useState('');

  const refreshTrainingCatalog = React.useCallback(async () => {
    try {
      const response = await fetch('/api/training/catalog', { cache: 'no-store' });
      const tracks = parseTrainingCatalogResponse(await response.json().catch(() => null));
      if (!response.ok || !tracks) return;
      setTrainingTracks(tracks);
      setTrainingTrackId((current) => current || tracks[0]?.id || '');
    } catch {
      /* optional training data must not block settings */
    }
  }, []);

  const refreshTrainingAssignments = React.useCallback(async () => {
    try {
      const response = await fetch('/api/training/assignments', { cache: 'no-store' });
      const assignments = parseTrainingAssignmentsResponse(await response.json().catch(() => null));
      if (response.ok && assignments) setTrainingAssignments(assignments);
    } catch {
      /* optional training data must not block settings */
    }
  }, []);

  const refreshTrainingProgress = React.useCallback(async () => {
    try {
      const response = await fetch('/api/training/progress', { cache: 'no-store' });
      const overview = parseTrainingProgressOverviewResponse(
        await response.json().catch(() => null)
      );
      if (response.ok && overview) setTrainingProgress(overview);
    } catch {
      /* optional training data must not block settings */
    }
  }, []);

  const assignTraining = React.useCallback(
    async (memberId: string, tenantSlug: string | undefined) => {
      if (!tenantSlug || !trainingTrackId) return;
      try {
        const response = await fetch('/api/training/assignments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenant_slug: tenantSlug,
            member_id: memberId,
            track_id: trainingTrackId,
          }),
        });
        if (!response.ok) throw new Error('Training assignment failed');
        setNotice({ text: frontDeskText('settings_member_updated', locale) });
        await refreshTrainingAssignments();
        await refreshTrainingProgress();
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
      }
    },
    [trainingTrackId, refreshTrainingAssignments, refreshTrainingProgress, setNotice, locale]
  );

  return {
    trainingTracks,
    trainingAssignments,
    trainingProgress,
    trainingTrackId,
    setTrainingTrackId,
    refreshTrainingCatalog,
    refreshTrainingAssignments,
    refreshTrainingProgress,
    assignTraining,
  };
}
