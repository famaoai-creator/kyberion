import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';

export type MissionTicketProvider = 'github' | 'jira';

const PROVIDER_SCHEMA_PATHS: Record<MissionTicketProvider, string> = {
  github: pathResolver.knowledge('product/schemas/mission-github-ticket-artifact.schema.json'),
  jira: pathResolver.knowledge('product/schemas/mission-jira-ticket-artifact.schema.json'),
};

/** Load an external ticket artifact through its provider-specific contract. */
export function loadMissionTicketProviderArtifactAtPath(
  filePath: string,
  provider: MissionTicketProvider
): Record<string, unknown> | null {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeFilePath)) return null;
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[MISSION_${provider.toUpperCase()}_TICKET] artifact must be a regular file`);
  }
  return defineCatalog<Record<string, unknown>>({
    id: `mission-${provider}-ticket-artifact`,
    path: safeFilePath,
    schema: PROVIDER_SCHEMA_PATHS[provider],
  }).load();
}
