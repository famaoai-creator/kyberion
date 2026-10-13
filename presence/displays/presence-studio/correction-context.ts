import type express from 'express';
import {
  conversationRef,
  presenceFrontDeskConversationViewer,
} from '@agent/core/surface/front-desk-conversation-store';
import {
  PresenceStudioViewerError,
  narrowPresenceStudioScope,
  presenceStudioRecordInScope,
  toFrontDeskViewerScope,
  type PresenceStudioViewerContext,
} from './security.js';

interface CorrectionRecordScope {
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
}
interface CorrectionEntry extends CorrectionRecordScope {
  entry_id: string;
  artifact_paths: string[];
  title: string;
  verdict_note?: string;
  status: string;
}
interface CorrectionArtifact extends CorrectionRecordScope {
  artifact_id: string;
  path?: string;
}
export interface CorrectionContext {
  entry_id: string;
  artifact_id: string;
  title: string;
  note: string;
  status: 'rejected' | 'changes_requested';
}

/** IDs select records, never authority or a downstream request. This projection
 * means only that feedback is saved; it makes no claim that revision work exists.
 * Keep it pure so tests cannot touch the live inbox or start a surface runtime. */
export function buildCorrectionContext(input: {
  entryId: string;
  artifactId: string;
  entries: readonly CorrectionEntry[];
  artifacts: readonly CorrectionArtifact[];
  viewer: PresenceStudioViewerContext;
}): CorrectionContext | null {
  const entries = input.entries.filter((entry) => entry.entry_id === input.entryId);
  const artifacts = input.artifacts.filter((artifact) => artifact.artifact_id === input.artifactId);
  if (entries.length !== 1 || artifacts.length !== 1) return null;
  const [entry] = entries;
  const [artifact] = artifacts;
  if (
    !presenceStudioRecordInScope(input.viewer, entry) ||
    !presenceStudioRecordInScope(input.viewer, artifact) ||
    !artifact.path ||
    !Array.isArray(entry.artifact_paths) ||
    !entry.artifact_paths.includes(artifact.path) ||
    (entry.status !== 'rejected' && entry.status !== 'changes_requested') ||
    typeof entry.title !== 'string' ||
    (entry.verdict_note !== undefined && typeof entry.verdict_note !== 'string')
  )
    return null;
  return {
    entry_id: entry.entry_id,
    artifact_id: artifact.artifact_id,
    title: entry.title,
    note: entry.verdict_note || '',
    status: entry.status,
  };
}

/** Read-only dependencies are supplied at registration, not loaded from the
 * surface runtime. Exact inbox selection happens before its store's limit. */
export interface CorrectionContextDependencies {
  resolveViewer: (req: express.Request) => PresenceStudioViewerContext;
  readEntries: (entryId: string) => readonly CorrectionEntry[];
  readArtifacts: () => readonly CorrectionArtifact[];
}

function validSelector(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim()
  );
}

export function registerCorrectionContextRoute(
  app: express.Express,
  dependencies: CorrectionContextDependencies
): void {
  app.get('/api/progress/:artifactId/correction-context', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const artifactId = req.params.artifactId;
    const entryId = req.query.entry;
    const { tenant, organizationId, projectId } = req.query;
    if (
      !validSelector(artifactId) ||
      !validSelector(entryId) ||
      [tenant, organizationId, projectId].some(
        (value) => value !== undefined && !validSelector(value)
      )
    ) {
      return res.status(400).json({ ok: false, error: 'correction_context_invalid' });
    }
    try {
      const viewer = narrowPresenceStudioScope(dependencies.resolveViewer(req), {
        tenant: tenant as string | undefined,
        organizationId: organizationId as string | undefined,
        projectId: projectId as string | undefined,
      });
      const context = buildCorrectionContext({
        entryId,
        artifactId,
        viewer,
        entries: dependencies.readEntries(entryId),
        artifacts: dependencies.readArtifacts(),
      });
      if (!context) {
        return res.status(404).json({ ok: false, error: 'correction_context_unavailable' });
      }
      const viewerScopeId = conversationRef(
        presenceFrontDeskConversationViewer(toFrontDeskViewerScope(viewer))
      ).key;
      return res.json({ ok: true, context, viewer_scope_id: viewerScopeId });
    } catch (error) {
      const status = error instanceof PresenceStudioViewerError ? error.status : 500;
      return res.status(status).json({
        ok: false,
        error:
          status === 401 || status === 403
            ? 'correction_context_denied'
            : 'correction_context_unavailable',
      });
    }
  });
}
