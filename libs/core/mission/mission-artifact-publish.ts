/**
 * Mission evidence → published deliverable.
 *
 * `delivery` tasks of a document / media mission end with "place the final
 * file at its destination". A provider CLI session has no principal identity,
 * so it cannot (and must not) write into a confidential project directory
 * itself. This is the governed hand-off: the mission controller publishes one
 * regular file under the mission's own `evidence/` tree as a `report` / `export`
 * scoped artifact with an ArtifactRecord. `finish` then carries it to its
 * durable home — the linked project (`mission-artifact-promotion.ts`) or, for
 * a mission without a project link, the owner's storage floor.
 *
 * Contract: idempotent (the record id derives from the mission, the evidence
 * path and the content digest, so a re-run republishes the same record), and
 * it never accepts a destination — placement is the owner's decision.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as pathResolver from '../path-resolver.js';
import { assertSafeRepositoryPath, safeLstat, safeReadFile } from '../secure-io.js';
import { isArtifactKind, type ArtifactKind } from '../workforce/artifact-registry.js';
import { writeScopedArtifact } from '../workforce/artifact-store.js';
import type { RetentionArtifactClass } from '../storage/storage-retention-catalog.js';
import { loadState } from './mission-state.js';

/** Classes `finish` hands to the project; evidence stays with the mission. */
export const PUBLISHABLE_ARTIFACT_CLASSES = ['report', 'export'] as const;
export type PublishableArtifactClass = (typeof PUBLISHABLE_ARTIFACT_CLASSES)[number];

const MAX_PUBLISH_BYTES = 64 * 1024 * 1024;

const KIND_BY_EXTENSION: Readonly<Record<string, ArtifactKind>> = Object.freeze({
  '.html': 'html',
  '.htm': 'html',
  '.md': 'markdown',
  '.json': 'json',
  '.csv': 'csv',
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.png': 'image',
  '.jpg': 'jpg',
  '.jpeg': 'jpeg',
  '.gif': 'gif',
  '.mp3': 'mp3',
  '.mp4': 'mp4',
});

export interface PublishMissionArtifactInput {
  missionId: string;
  /** Repo-root-relative or mission-relative path under the mission's `evidence/` tree. */
  evidencePath: string;
  artifactClass?: PublishableArtifactClass;
  /** Published file name. Defaults to the evidence file's basename. */
  name?: string;
  /** ArtifactRecord kind. Defaults from the file extension. */
  kind?: string;
}

export interface PublishMissionArtifactResult {
  artifact_id: string;
  mission_id: string;
  artifact_class: PublishableArtifactClass;
  kind: ArtifactKind;
  source: string;
  path: string;
  content_sha256: string;
  /** Where `finish` will carry the deliverable. */
  destination: 'project' | 'owner_floor';
  project_id?: string;
  next: string;
}

function fail(what: string, why: string, next: string): never {
  throw new Error(`[MISSION_PUBLISH_ARTIFACT] ${what} — ${why} | next: ${next}`);
}

function resolveEvidenceSource(missionDir: string, evidencePath: string): string {
  const raw = evidencePath.trim();
  if (!raw) fail('--path is required', 'no evidence file named', 'pass --path evidence/<file>');
  const evidenceDir = path.join(missionDir, 'evidence');
  // Accept an absolute path, a repo-relative `active/...` path, `evidence/x`
  // (mission-relative) and a bare `x` (relative to evidence/).
  const resolved = path.isAbsolute(raw)
    ? path.normalize(raw)
    : raw.startsWith('active/')
      ? pathResolver.rootResolve(raw)
      : raw.startsWith('evidence/')
        ? path.join(missionDir, raw)
        : path.join(evidenceDir, raw);
  if (!pathResolver.isPathInside(evidenceDir, resolved)) {
    fail(
      `${evidencePath} is outside the mission evidence tree`,
      'only files the mission itself produced can be published',
      'copy the file into the mission evidence/ directory first (mission-governed write), then retry'
    );
  }
  const safe = assertSafeRepositoryPath(resolved);
  const stats = safeLstat(safe);
  // A hard link would let a file of another scope pass as a mission file.
  if (!stats.isFile() || stats.nlink > 1) {
    fail(
      `${evidencePath} is not a regular, unlinked file`,
      'directories, symlinks and hard links are refused',
      'point --path at the final file itself'
    );
  }
  if (stats.size > MAX_PUBLISH_BYTES) {
    fail(
      `${evidencePath} is ${stats.size} bytes`,
      `the publish limit is ${MAX_PUBLISH_BYTES} bytes`,
      'publish a smaller file'
    );
  }
  return safe;
}

export function publishMissionEvidenceArtifact(
  input: PublishMissionArtifactInput
): PublishMissionArtifactResult {
  const missionId = input.missionId.trim().toUpperCase();
  const state = loadState(missionId);
  const missionDir = pathResolver.findMissionPath(missionId);
  if (!state || !missionDir) {
    fail(`mission ${missionId} not found`, 'no active mission state', 'check pnpm mission list');
  }
  if (state.status !== 'active' && state.status !== 'paused') {
    fail(
      `mission ${missionId} is ${state.status}`,
      'deliverables are published while the mission is still open',
      'publish before finish'
    );
  }
  const artifactClass: PublishableArtifactClass = input.artifactClass ?? 'report';
  if (!PUBLISHABLE_ARTIFACT_CLASSES.includes(artifactClass)) {
    fail(
      `class ${String(artifactClass)} is not publishable`,
      `finish only hands ${PUBLISHABLE_ARTIFACT_CLASSES.join(' / ')} to the project`,
      'use --class report or --class export'
    );
  }
  const source = resolveEvidenceSource(missionDir, input.evidencePath);
  const sourceRelative = path.relative(missionDir, source).split(path.sep).join('/');
  const name = (input.name?.trim() || path.basename(source)).replace(/\\/g, '/');
  const requestedKind = input.kind?.trim() || KIND_BY_EXTENSION[path.extname(name).toLowerCase()];
  if (!requestedKind || !isArtifactKind(requestedKind)) {
    fail(
      `cannot choose an artifact kind for ${name}`,
      requestedKind ? `'${requestedKind}' is not a registered kind` : 'unknown file extension',
      'pass --kind <registered artifact kind>'
    );
  }
  const content = safeReadFile(source, { encoding: null }) as Buffer;
  const digest = createHash('sha256').update(content).digest('hex');
  const artifactId =
    'ART-PUB-' +
    createHash('sha256')
      .update(`${missionId}\0${sourceRelative}\0${digest}`)
      .digest('hex')
      .slice(0, 16)
      .toUpperCase();

  const written = writeScopedArtifact({
    scope: { mission: missionId },
    tier: state.tier,
    artifact_class: artifactClass as RetentionArtifactClass,
    name,
    content,
    format: 'buffer',
    publish: {
      kind: requestedKind,
      artifact_id: artifactId,
      metadata: {
        published_by: 'mission_controller publish-artifact',
        source_evidence_path: sourceRelative,
        content_sha256: digest,
      },
    },
  });

  const projectId = state.relationships?.project?.project_id;
  return {
    artifact_id: written.artifact_id ?? artifactId,
    mission_id: missionId,
    artifact_class: artifactClass,
    kind: requestedKind,
    source: sourceRelative,
    path: written.repo_relative_path,
    content_sha256: digest,
    destination: projectId ? 'project' : 'owner_floor',
    ...(projectId ? { project_id: projectId } : {}),
    next: projectId
      ? `finish copies it to project ${projectId} (artifacts/${artifactClass}/missions/${missionId}/)`
      : 'this mission has no project link: finish copies it to the owner storage floor ' +
        '(active/shared/artifacts/<tier>/<tenant>/). To land it in a project, link the mission ' +
        'first (pnpm mission reassign-project <ID> --project-id <PROJECT_ID> while paused/planned).',
  };
}
