/** Scoped document intake publishes an existing artifact, never a tenant-wide knowledge card. */
import { createHash } from 'node:crypto';
import type { OsKnowledgeTier } from '../cloudflare-os-control-plane.js';
import * as path from 'node:path';
import {
  readDocument,
  inferDocumentFormat,
  type ReadableDocumentFormat,
} from '../media/document-reader.js';
import { scrubContent } from '../pii-scrubber.js';
import {
  writeScopedArtifact,
  type WriteScopedArtifactInput,
  type WriteScopedArtifactResult,
} from '../workforce/artifact-store.js';
import {
  workspaceScopeMatchesResource,
  type ResolvedWorkspaceScope,
  type WorkspaceSelection,
} from './workspace-scope.js';

export interface ScopedWorkspaceIngestInput {
  workspace: ResolvedWorkspaceScope;
  fileName: string;
  bytes: Uint8Array;
  format?: string;
  actorId: string;
  dryRun?: boolean;
}
export interface ScopedWorkspaceIngestDependencies {
  parse: (
    bytes: Buffer,
    format: ReadableDocumentFormat,
    tenantSlug: string | undefined,
    tier: OsKnowledgeTier
  ) => Promise<{ markdown: string; title?: string }>;
  write: (input: WriteScopedArtifactInput) => WriteScopedArtifactResult;
}
const dependencies: ScopedWorkspaceIngestDependencies = {
  parse: (bytes, format, tenantSlug, tier) =>
    readDocument(bytes, format, {
      ocr: false,
      tenantSlug,
      tier,
      trainingUse: 'local_only',
    }),
  write: writeScopedArtifact,
};
const formats = new Set(['docx', 'pdf', 'xlsx', 'pptx', 'html', 'markdown', 'text']);

export async function ingestScopedWorkspaceDocument(
  input: ScopedWorkspaceIngestInput,
  ports: ScopedWorkspaceIngestDependencies = dependencies
) {
  const selected = input.workspace.selection;
  if (
    (!selected.project_id && !selected.organization_id) ||
    !selected.tier ||
    (selected.tier === 'confidential' && !selected.tenant_slug) ||
    !input.actorId?.trim() ||
    !input.bytes?.byteLength ||
    input.bytes.byteLength > 25 * 1024 * 1024 ||
    (selected.operation_id && selected.project_id) ||
    !workspaceScopeMatchesResource(input.workspace, selected)
  )
    throw new Error(
      '[WORKSPACE_INGEST_SCOPE] Select an authorized organization, project or operation before uploading.'
    );
  const storageScope: WorkspaceSelection = {
    tier: selected.tier,
    ...(selected.tenant_slug ? { tenant_slug: selected.tenant_slug } : {}),
    ...(selected.organization_id ? { organization_id: selected.organization_id } : {}),
    ...(selected.project_id ? { project_id: selected.project_id } : {}),
  };
  const fileName = path.basename(String(input.fileName || '')).slice(0, 160);
  const format = input.format || inferDocumentFormat(fileName);
  if (!fileName || !format || !formats.has(format))
    throw new Error('[WORKSPACE_INGEST_FORMAT] Select a supported document format.');
  const sourceHash = createHash('sha256').update(input.bytes).digest('hex');
  const parsed = await ports.parse(
    Buffer.from(input.bytes),
    format as ReadableDocumentFormat,
    selected.tenant_slug,
    selected.tier
  );
  const name = scrubContent(parsed.title || fileName);
  const content = scrubContent(parsed.markdown);
  if (name.blocked || content.blocked)
    throw new Error(
      '[WORKSPACE_INGEST_BLOCKED] The PII/secret gate blocked this document; remove the detected secrets and upload again.'
    );
  if (!content.scrubbed_text.trim())
    throw new Error('[WORKSPACE_INGEST_EMPTY] No readable document content was extracted.');
  const artifactId =
    'ART-WORKSPACE-' +
    createHash('sha256')
      .update(JSON.stringify([storageScope, sourceHash, fileName]))
      .digest('hex')
      .slice(0, 32);
  const common = {
    name: name.scrubbed_text,
    scope: storageScope,
    selectedWorkspace: selected,
    source_sha256: sourceHash,
    ...(selected.operation_id ? { inheritedScope: 'organization' as const } : {}),
  };
  if (input.dryRun) return { ...common, outcome: 'would_commit' as const };
  const written = ports.write({
    scope: {
      ...(selected.tenant_slug ? { tenant: selected.tenant_slug } : {}),
      ...(selected.organization_id ? { organization: selected.organization_id } : {}),
      ...(selected.project_id ? { project: selected.project_id } : {}),
    },
    tier: selected.tier,
    role: 'sovereign_concierge',
    artifact_class: 'report',
    name: `context-library/${artifactId}.md`,
    format: 'text',
    content: content.scrubbed_text,
    publish: {
      artifact_id: artifactId,
      kind: 'document',
      organization_id: selected.organization_id,
      preview_text: content.scrubbed_text.slice(0, 512),
      metadata: {
        title: name.scrubbed_text,
        workspace_context: true,
        scope: storageScope,
        source_sha256: sourceHash,
        ingested_by: input.actorId,
        source_system: 'workspace-upload',
        requested_workspace: selected,
        ...(selected.operation_id ? { inherited_scope: 'organization' } : {}),
      },
    },
  });
  if (written.artifact_id !== artifactId)
    throw new Error(
      '[WORKSPACE_INGEST_UNVERIFIED] Artifact publication did not return the expected receipt; verify before retrying.'
    );
  return {
    ...common,
    outcome: 'committed' as const,
    artifact_id: artifactId,
    target_path: written.repo_relative_path,
  };
}
