import * as path from 'node:path';
import * as pathResolver from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core/secure-io';
import { readJson } from '@agent/core/foundation';

export type ContractCheck = {
  id: string;
  schemaPath: string;
  validPayloads: unknown[];
  invalidPayloads: unknown[];
};

export function readGovernanceJson(relativePath: string): unknown {
  const safePath = assertSafeRepositoryPath(pathResolver.rootResolve(relativePath));
  if (!safeLstat(safePath).isFile())
    throw new Error(`Governance resource is not a file: ${relativePath}`);
  const payload = readJson<Record<string, unknown>>(safePath);
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && '$schema' in payload) {
    const { $schema: _schema, ...contract } = payload;
    return contract;
  }
  return payload;
}

function safeGovernanceJsonEntries(relativeDir: string): string[] {
  try {
    const dir = assertSafeRepositoryPath(pathResolver.rootResolve(relativeDir), {
      allowMissingLeaf: true,
    });
    if (!safeExistsSync(dir) || !safeLstat(dir).isDirectory()) return [];
    return safeReaddir(dir)
      .filter((entry) => entry.endsWith('.json'))
      .filter((entry) => {
        try {
          const candidate = assertSafeRepositoryPath(path.join(dir, entry));
          return safeLstat(candidate).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

function readGovernanceJsonDirectory(relativeDir: string): unknown[] {
  return safeGovernanceJsonEntries(relativeDir).flatMap((entry) => {
    try {
      return [readGovernanceJson(path.join(relativeDir, entry))];
    } catch {
      return [];
    }
  });
}

const GOLDEN_SCENARIO_CATALOG_ALLOWLIST = new Set([
  'mission-orchestration-scenario-pack.json',
  'mission-workflow-catalog.json',
]);

export function findUnmanagedGoldenScenarioCatalogs(): string[] {
  return safeGovernanceJsonEntries('knowledge/product/governance')
    .map((entry) => path.basename(entry))
    .filter((entry) => {
      const isGoldenScenarioCatalog =
        entry.includes('deterministic') ||
        entry.includes('golden-scenario') ||
        entry.includes('scenario-catalog') ||
        entry.includes('workflow-catalog');
      return isGoldenScenarioCatalog && !GOLDEN_SCENARIO_CATALOG_ALLOWLIST.has(entry);
    })
    .map((entry) => `knowledge/product/governance/${entry}`)
    .sort();
}

export function readSurfaceManifestPayloads(): unknown[] {
  return readGovernanceJsonDirectory('knowledge/product/governance/surfaces');
}

export function readSurfaceProviderCatalogPayloads(): unknown[] {
  return readGovernanceJsonDirectory(
    'knowledge/product/governance/surface-provider-manifest-catalogs'
  );
}

export function readServiceEndpointPayloads(): unknown[] {
  return readGovernanceJsonDirectory('knowledge/product/orchestration/service-endpoints');
}

export function readServicePresetPayloads(): unknown[] {
  return readGovernanceJsonDirectory('knowledge/product/orchestration/service-presets');
}

export function readAgentProfilePayloads(): unknown[] {
  return readGovernanceJsonDirectory('knowledge/product/orchestration/agent-profiles');
}

export function readVoiceProfilePayloads(): unknown[] {
  return readGovernanceJsonDirectory('knowledge/product/governance/voice-profiles');
}

export function readSpecialistPayloads(): unknown[] {
  return readGovernanceJsonDirectory('knowledge/product/orchestration/specialists');
}

export function readAuthorityRolePayloads(): unknown[] {
  return readGovernanceJsonDirectory('knowledge/product/governance/authority-roles');
}

export function readTeamRolePayloads(): unknown[] {
  return readGovernanceJsonDirectory('knowledge/product/orchestration/team-roles');
}
