/**
 * scripts/refactor/mission-publish-commands.ts
 *
 * Command body for `mission publish-artifact`. Kept out of
 * mission_controller.ts (a thin orchestration layer at its line budget).
 */
import {
  publishMissionEvidenceArtifact,
  type PublishableArtifactClass,
  type PublishMissionArtifactResult,
} from '@agent/core/mission/mission-artifact-publish';

type Print = (value: unknown) => void;

export interface PublishArtifactCommandOptions {
  path?: string;
  artifactClass?: string;
  name?: string;
  kind?: string;
  json?: boolean;
}

export function runPublishArtifact(
  missionId: string,
  options: PublishArtifactCommandOptions,
  print: Print
): PublishMissionArtifactResult {
  if (!options.path) {
    throw new Error(
      '[MISSION_PUBLISH_ARTIFACT] --path is required — no evidence file named | ' +
        `next: pnpm mission publish-artifact ${missionId.toUpperCase()} --path evidence/<file>`
    );
  }
  const result = publishMissionEvidenceArtifact({
    missionId,
    evidencePath: options.path,
    artifactClass: options.artifactClass as PublishableArtifactClass | undefined,
    name: options.name,
    kind: options.kind,
  });
  if (options.json) {
    print(JSON.stringify(result, null, 2));
  } else {
    print(
      [
        `Published ${result.source} as ${result.artifact_class}/${result.kind}`,
        `  artifact_id: ${result.artifact_id}`,
        `  path:        ${result.path}`,
        `  sha256:      ${result.content_sha256}`,
        `  destination: ${result.destination}${result.project_id ? ` (${result.project_id})` : ''}`,
        `  next:        ${result.next}`,
      ].join('\n')
    );
  }
  return result;
}
