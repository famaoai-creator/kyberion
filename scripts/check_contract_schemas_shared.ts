import { pathResolver, safeExistsSync, safeReaddir } from '@agent/core';
import { readJsonFile } from './refactor/cli-input.js';

export type ContractCheck = {
  id: string;
  schemaPath: string;
  validPayloads: unknown[];
  invalidPayloads: unknown[];
};

export function readGovernanceJson(relativePath: string): unknown {
  return readJsonFile(pathResolver.rootResolve(relativePath));
}

const GOLDEN_SCENARIO_CATALOG_ALLOWLIST = new Set([
  'mission-orchestration-scenario-pack.json',
  'mission-workflow-catalog.json',
]);

export function findUnmanagedGoldenScenarioCatalogs(): string[] {
  const dir = pathResolver.rootResolve('knowledge/product/governance');
  if (!safeExistsSync(dir)) return [];

  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
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
  const dir = pathResolver.rootResolve('knowledge/product/governance/surfaces');
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => readGovernanceJson(`knowledge/product/governance/surfaces/${entry}`));
}

export function readSurfaceProviderCatalogPayloads(): unknown[] {
  const dir = pathResolver.rootResolve(
    'knowledge/product/governance/surface-provider-manifest-catalogs'
  );
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) =>
      readGovernanceJson(`knowledge/product/governance/surface-provider-manifest-catalogs/${entry}`)
    );
}

export function readServiceEndpointPayloads(): unknown[] {
  const dir = pathResolver.rootResolve('knowledge/product/orchestration/service-endpoints');
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) =>
      readGovernanceJson(`knowledge/product/orchestration/service-endpoints/${entry}`)
    );
}

export function readServicePresetPayloads(): unknown[] {
  const dir = pathResolver.rootResolve('knowledge/product/orchestration/service-presets');
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => readGovernanceJson(`knowledge/product/orchestration/service-presets/${entry}`));
}

export function readAgentProfilePayloads(): unknown[] {
  const dir = pathResolver.rootResolve('knowledge/product/orchestration/agent-profiles');
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => readGovernanceJson(`knowledge/product/orchestration/agent-profiles/${entry}`));
}

export function readVoiceProfilePayloads(): unknown[] {
  const dir = pathResolver.rootResolve('knowledge/product/governance/voice-profiles');
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => readGovernanceJson(`knowledge/product/governance/voice-profiles/${entry}`));
}

export function readSpecialistPayloads(): unknown[] {
  const dir = pathResolver.rootResolve('knowledge/product/orchestration/specialists');
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => readGovernanceJson(`knowledge/product/orchestration/specialists/${entry}`));
}

export function readAuthorityRolePayloads(): unknown[] {
  const dir = pathResolver.rootResolve('knowledge/product/governance/authority-roles');
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => readGovernanceJson(`knowledge/product/governance/authority-roles/${entry}`));
}

export function readTeamRolePayloads(): unknown[] {
  const dir = pathResolver.rootResolve('knowledge/product/orchestration/team-roles');
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => readGovernanceJson(`knowledge/product/orchestration/team-roles/${entry}`));
}
