import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReaddir } from '@agent/core/secure-io';
import { loadActuatorManifestCatalog } from '@agent/core/actuator-manifest-index';
import {
  loadServiceEndpointsDirectoryCatalog,
  type ServiceEndpointsCatalog,
} from '@agent/core/service-endpoint-registry';
import {
  loadAgentProfileDirectory,
  loadAgentProfileSnapshot,
  loadAuthorityRoleIndex as loadGovernedAuthorityRoleIndex,
  loadTeamRoleDirectory,
  loadTeamRoleSnapshot,
} from '@agent/core/mission-team-index';
import { loadSurfaceProviderManifestCatalogDirectory } from '@agent/core/surface-provider-manifest-catalog';
import { loadVoiceEngineRegistryDirectory } from '@agent/core/voice-engine-registry';
import { loadVoiceProfileRegistryDirectory } from '@agent/core/voice-profile-registry';
import { loadSpecialistCatalog } from '@agent/core/work-design';
import { defineCatalog } from '@agent/core/foundation';

type VoiceProfileSnapshot = {
  default_profile_id?: string;
  profiles?: Array<{ profile_id?: string }>;
};

type AuthorityRoleSnapshot = {
  authority_roles?: Record<string, unknown>;
};

type SurfaceProviderSnapshot = {
  entries?: Array<{ id?: string }>;
};

type SpecialistSnapshot = {
  version?: string;
  specialists?: Record<string, unknown>;
};

type VoiceEngineSnapshot = {
  default_engine_id?: string;
  engines?: Array<{ engine_id?: string }>;
};

type GlobalActuatorIndexSnapshot = {
  v?: string;
  t?: number;
  u?: string;
  actuators?: Array<{
    n?: string;
    path?: string;
    d?: string;
    s?: string;
    version?: string;
    capability_count?: number;
    ops?: string[];
    contract_schema?: string;
    prerequisites_summary?: string;
  }>;
};

const serviceEndpointsSnapshotCatalog = defineCatalog<ServiceEndpointsCatalog>({
  id: 'service-endpoints-snapshot',
  path: pathResolver.knowledge('product/orchestration/service-endpoints.json'),
  schema: pathResolver.knowledge('product/schemas/service-endpoints.schema.json'),
});

const voiceProfileSnapshotCatalog = defineCatalog<VoiceProfileSnapshot>({
  id: 'voice-profile-registry-snapshot',
  path: pathResolver.knowledge('product/governance/voice-profile-registry.json'),
  schema: pathResolver.knowledge('product/schemas/voice-profile-registry.schema.json'),
});

const authorityRoleSnapshotCatalog = defineCatalog<AuthorityRoleSnapshot>({
  id: 'authority-role-index-snapshot',
  path: pathResolver.knowledge('product/governance/authority-role-index.json'),
  schema: pathResolver.knowledge('product/schemas/authority-role-index.schema.json'),
});

const surfaceProviderSnapshotCatalog = defineCatalog<SurfaceProviderSnapshot>({
  id: 'surface-provider-manifest-catalog-snapshot',
  path: pathResolver.knowledge('product/governance/surface-provider-manifest-catalog.json'),
  schema: pathResolver.knowledge('product/schemas/surface-provider-manifest-catalog.schema.json'),
});

const specialistSnapshotCatalog = defineCatalog<SpecialistSnapshot>({
  id: 'specialist-catalog-snapshot',
  path: pathResolver.knowledge('product/orchestration/specialist-catalog.json'),
  schema: pathResolver.knowledge('product/schemas/specialist-catalog.schema.json'),
});

const voiceEngineSnapshotCatalog = defineCatalog<VoiceEngineSnapshot>({
  id: 'voice-engine-registry-snapshot',
  path: pathResolver.knowledge('product/governance/voice-engine-registry.json'),
  schema: pathResolver.knowledge('product/schemas/voice-engine-registry.schema.json'),
});

const globalActuatorIndexSnapshotCatalog = defineCatalog<GlobalActuatorIndexSnapshot>({
  id: 'global-actuator-index-snapshot',
  path: pathResolver.knowledge('product/orchestration/global_actuator_index.json'),
  schema: pathResolver.knowledge('product/schemas/global-actuator-index.schema.json'),
});

export function validateAgentProfileDirectoryConsistency(violations: string[]) {
  const directory = pathResolver.rootResolve('knowledge/product/orchestration/agent-profiles');
  if (!safeExistsSync(directory)) {
    violations.push(
      'agent-profile-index: knowledge/product/orchestration/agent-profiles directory is missing'
    );
    return;
  }

  const files = safeReaddir(directory)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (!files.length) {
    violations.push(
      'agent-profile-index: knowledge/product/orchestration/agent-profiles directory is empty'
    );
    return;
  }

  const snapshotAgents = loadAgentProfileSnapshot();
  let directoryAgents: ReturnType<typeof loadAgentProfileDirectory>;
  try {
    directoryAgents = loadAgentProfileDirectory();
  } catch (error) {
    violations.push(
      `agent-profile-index: canonical directory failed governed loading (${error instanceof Error ? error.message : String(error)})`
    );
    return;
  }
  const seenAgentIds = new Set<string>();

  for (const file of files) {
    const agentId = file.replace(/\.json$/i, '');
    const data = directoryAgents?.[agentId];
    if (!data) {
      violations.push(`agent-profile-index/${file}: canonical loader did not return this agent`);
      continue;
    }

    if (!(agentId in snapshotAgents)) {
      violations.push(`agent-profile-index/${file}: snapshot is missing agent ${agentId}`);
    } else if (JSON.stringify(data) !== JSON.stringify(snapshotAgents[agentId])) {
      violations.push(`agent-profile-index/${file}: directory entry does not match snapshot`);
    }

    seenAgentIds.add(agentId);
  }

  const snapshotIds = Object.keys(snapshotAgents).sort();
  const directoryIds = [...seenAgentIds].sort();
  if (JSON.stringify(snapshotIds) !== JSON.stringify(directoryIds)) {
    violations.push('agent-profile-index: snapshot and canonical directory agent ids diverge');
  }
}

export function validateVoiceProfileDirectoryConsistency(violations: string[]) {
  const directory = pathResolver.rootResolve('knowledge/product/governance/voice-profiles');
  if (!safeExistsSync(directory)) {
    violations.push(
      'voice-profile-registry: knowledge/product/governance/voice-profiles directory is missing'
    );
    return;
  }

  const files = safeReaddir(directory)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (!files.length) {
    violations.push(
      'voice-profile-registry: knowledge/product/governance/voice-profiles directory is empty'
    );
    return;
  }

  const snapshot = voiceProfileSnapshotCatalog.load();
  const snapshotProfiles = snapshot.profiles || [];
  const snapshotIds = new Set(snapshotProfiles.map((profile) => String(profile.profile_id || '')));
  let directoryRegistry: ReturnType<typeof loadVoiceProfileRegistryDirectory>;
  try {
    directoryRegistry = loadVoiceProfileRegistryDirectory(directory);
  } catch (error) {
    violations.push(
      `voice-profile-registry: canonical directory failed governed loading (${String(error)})`
    );
    return;
  }
  const directoryProfiles = new Map(
    directoryRegistry.profiles.map((profile) => [profile.profile_id, profile])
  );
  const directoryIds: string[] = [];

  for (const file of files) {
    const profileId = file.replace(/\.json$/i, '');
    if (!directoryProfiles.has(profileId)) {
      violations.push(
        `voice-profile-registry/${file}: governed loader did not return this profile`
      );
      continue;
    }
    if (!snapshotIds.has(profileId)) {
      violations.push(`voice-profile-registry/${file}: snapshot is missing profile ${profileId}`);
    }
    directoryIds.push(profileId);
  }

  const sortedDirectoryIds = directoryIds.sort();
  const sortedSnapshotIds = [...snapshotIds].sort();
  if (JSON.stringify(sortedDirectoryIds) !== JSON.stringify(sortedSnapshotIds)) {
    violations.push('voice-profile-registry: snapshot and canonical directory profile ids diverge');
  }

  if (
    String(snapshot.default_profile_id || '') &&
    !snapshotIds.has(String(snapshot.default_profile_id || ''))
  ) {
    violations.push(
      'voice-profile-registry: default_profile_id must reference a profile in the canonical directory'
    );
  }
}

export function validateAuthorityRoleDirectoryConsistency(violations: string[]) {
  const directory = pathResolver.rootResolve('knowledge/product/governance/authority-roles');
  if (!safeExistsSync(directory)) {
    violations.push(
      'authority-role-index: knowledge/product/governance/authority-roles directory is missing'
    );
    return;
  }

  const files = safeReaddir(directory)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (!files.length) {
    violations.push(
      'authority-role-index: knowledge/product/governance/authority-roles directory is empty'
    );
    return;
  }

  const snapshot = authorityRoleSnapshotCatalog.load();
  const snapshotRoles = snapshot.authority_roles || {};
  let directoryRoles: ReturnType<typeof loadGovernedAuthorityRoleIndex>;
  try {
    directoryRoles = loadGovernedAuthorityRoleIndex();
  } catch (error) {
    violations.push(
      `authority-role-index: canonical directory failed governed loading (${error instanceof Error ? error.message : String(error)})`
    );
    return;
  }
  const seenRoleIds = new Set<string>();

  for (const file of files) {
    const role = file.replace(/\.json$/i, '');
    const data = directoryRoles[role];
    if (!data) {
      violations.push(`authority-role-index/${file}: canonical loader did not return this role`);
      continue;
    }

    const snapshotEntry = snapshotRoles[role];
    if (!snapshotEntry) {
      violations.push(`authority-role-index/${file}: snapshot is missing role ${role}`);
    } else {
      if (JSON.stringify(data) !== JSON.stringify(snapshotEntry)) {
        violations.push(`authority-role-index/${file}: directory entry does not match snapshot`);
      }
    }

    seenRoleIds.add(role);
  }

  const snapshotIds = Object.keys(snapshotRoles).sort();
  const directoryIds = [...seenRoleIds].sort();
  if (JSON.stringify(snapshotIds) !== JSON.stringify(directoryIds)) {
    violations.push('authority-role-index: snapshot and canonical directory role ids diverge');
  }
}

export function validateTeamRoleDirectoryConsistency(violations: string[]) {
  const directory = pathResolver.rootResolve('knowledge/product/orchestration/team-roles');
  if (!safeExistsSync(directory)) {
    violations.push(
      'team-role-index: knowledge/product/orchestration/team-roles directory is missing'
    );
    return;
  }

  const files = safeReaddir(directory)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (!files.length) {
    violations.push(
      'team-role-index: knowledge/product/orchestration/team-roles directory is empty'
    );
    return;
  }

  const snapshotRoles = loadTeamRoleSnapshot();
  let directoryRoles: ReturnType<typeof loadTeamRoleDirectory>;
  try {
    directoryRoles = loadTeamRoleDirectory();
  } catch (error) {
    violations.push(
      `team-role-index: canonical directory failed governed loading (${error instanceof Error ? error.message : String(error)})`
    );
    return;
  }
  const seenRoleIds = new Set<string>();

  for (const file of files) {
    const role = file.replace(/\.json$/i, '');
    const data = directoryRoles?.[role];
    if (!data) {
      violations.push(`team-role-index/${file}: canonical loader did not return this role`);
      continue;
    }

    const snapshotEntry = snapshotRoles[role];
    if (!snapshotEntry) {
      violations.push(`team-role-index/${file}: snapshot is missing role ${role}`);
    } else {
      if (JSON.stringify(data) !== JSON.stringify(snapshotEntry)) {
        violations.push(`team-role-index/${file}: directory entry does not match snapshot`);
      }
    }

    seenRoleIds.add(role);
  }

  const snapshotIds = Object.keys(snapshotRoles).sort();
  const directoryIds = [...seenRoleIds].sort();
  if (JSON.stringify(snapshotIds) !== JSON.stringify(directoryIds)) {
    violations.push('team-role-index: snapshot and canonical directory role ids diverge');
  }
}

export function validateSurfaceProviderCatalogDirectoryConsistency(violations: string[]) {
  const directory = pathResolver.rootResolve(
    'knowledge/product/governance/surface-provider-manifest-catalogs'
  );
  if (!safeExistsSync(directory)) {
    violations.push(
      'surface-provider-manifest-catalog: knowledge/product/governance/surface-provider-manifest-catalogs directory is missing'
    );
    return;
  }

  const files = safeReaddir(directory)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (!files.length) {
    violations.push(
      'surface-provider-manifest-catalog: knowledge/product/governance/surface-provider-manifest-catalogs directory is empty'
    );
    return;
  }

  const snapshot = surfaceProviderSnapshotCatalog.load();
  const snapshotIds = new Set((snapshot.entries || []).map((entry) => String(entry.id || '')));
  let directoryCatalog: ReturnType<typeof loadSurfaceProviderManifestCatalogDirectory>;
  try {
    directoryCatalog = loadSurfaceProviderManifestCatalogDirectory();
  } catch (error) {
    violations.push(
      `surface-provider-manifest-catalog: canonical directory failed governed loading (${String(error)})`
    );
    return;
  }
  const directoryEntries = new Map(directoryCatalog.entries.map((entry) => [entry.id, entry]));
  const directoryIds: string[] = [];

  for (const file of files) {
    const id = file.replace(/\.json$/i, '');
    if (!directoryEntries.has(id)) {
      violations.push(
        `surface-provider-manifest-catalog/${file}: governed loader did not return this entry`
      );
      continue;
    }
    if (!snapshotIds.has(id)) {
      violations.push(`surface-provider-manifest-catalog/${file}: snapshot is missing entry ${id}`);
    }
    directoryIds.push(id);
  }

  if (JSON.stringify(directoryIds.sort()) !== JSON.stringify([...snapshotIds].sort())) {
    violations.push(
      'surface-provider-manifest-catalog: snapshot and canonical directory entry ids diverge'
    );
  }
}

export function validateServiceEndpointsDirectoryConsistency(violations: string[]) {
  const directory = pathResolver.rootResolve('knowledge/product/orchestration/service-endpoints');
  if (!safeExistsSync(directory)) {
    violations.push(
      'service-endpoints: knowledge/product/orchestration/service-endpoints directory is missing'
    );
    return;
  }

  const files = safeReaddir(directory)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (!files.length) {
    violations.push(
      'service-endpoints: knowledge/product/orchestration/service-endpoints directory is empty'
    );
    return;
  }

  const snapshot = serviceEndpointsSnapshotCatalog.load();
  const snapshotIds = new Set(
    Object.keys(snapshot.services || {}).map((entry) => String(entry || ''))
  );
  let directoryCatalog: ReturnType<typeof loadServiceEndpointsDirectoryCatalog>;
  try {
    directoryCatalog = loadServiceEndpointsDirectoryCatalog(directory);
  } catch (error) {
    violations.push(
      `service-endpoints: canonical directory failed governed loading (${String(error)})`
    );
    return;
  }
  const directoryIds: string[] = [];

  for (const file of files) {
    const id = file.replace(/\.json$/i, '');
    const directoryRecord = directoryCatalog.services[id];
    if (!directoryRecord) {
      violations.push(`service-endpoints/${file}: governed loader did not return this service`);
      continue;
    }
    if (directoryCatalog.default_pattern !== snapshot.default_pattern) {
      violations.push(`service-endpoints/${file}: default_pattern must match the snapshot`);
    }
    if (!snapshotIds.has(id)) {
      violations.push(`service-endpoints/${file}: snapshot is missing service ${id}`);
    }
    const snapshotAliasList = snapshot.services?.[id]?.intent_aliases || [];
    const directoryAliasList = directoryRecord.intent_aliases || [];
    if (JSON.stringify(snapshotAliasList) !== JSON.stringify(directoryAliasList)) {
      violations.push(`service-endpoints/${file}: intent_aliases must match the snapshot`);
    }
    directoryIds.push(id);
  }

  if (JSON.stringify(directoryIds.sort()) !== JSON.stringify([...snapshotIds].sort())) {
    violations.push('service-endpoints: snapshot and canonical directory service ids diverge');
  }
}

export function validateSpecialistCatalogDirectoryConsistency(violations: string[]) {
  const directory = pathResolver.rootResolve('knowledge/product/orchestration/specialists');
  if (!safeExistsSync(directory)) {
    violations.push(
      'specialist-catalog: knowledge/product/orchestration/specialists directory is missing'
    );
    return;
  }

  const files = safeReaddir(directory)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (!files.length) {
    violations.push(
      'specialist-catalog: knowledge/product/orchestration/specialists directory is empty'
    );
    return;
  }

  const snapshot = specialistSnapshotCatalog.load();
  const snapshotIds = new Set(
    Object.keys(snapshot.specialists || {}).map((entry) => String(entry || ''))
  );
  let directorySpecialists: ReturnType<typeof loadSpecialistCatalog>;
  try {
    directorySpecialists = loadSpecialistCatalog();
  } catch (error) {
    violations.push(
      `specialist-catalog: canonical directory failed governed loading (${error instanceof Error ? error.message : String(error)})`
    );
    return;
  }
  const directoryIds: string[] = [];

  for (const file of files) {
    const id = file.replace(/\.json$/i, '');
    if (!directorySpecialists[id]) {
      violations.push(
        `specialist-catalog/${file}: canonical loader did not return this specialist`
      );
      continue;
    }

    if (!snapshotIds.has(id)) {
      violations.push(`specialist-catalog/${file}: snapshot is missing specialist ${id}`);
    }
    directoryIds.push(id);
  }

  if (JSON.stringify(directoryIds.sort()) !== JSON.stringify([...snapshotIds].sort())) {
    violations.push('specialist-catalog: snapshot and canonical directory specialist ids diverge');
  }
}

export function validateVoiceEngineDirectoryConsistency(violations: string[]) {
  const directory = pathResolver.rootResolve('knowledge/product/governance/voice-engines');
  if (!safeExistsSync(directory)) {
    violations.push(
      'voice-engine-registry: knowledge/product/governance/voice-engines directory is missing'
    );
    return;
  }

  const files = safeReaddir(directory)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (!files.length) {
    violations.push(
      'voice-engine-registry: knowledge/product/governance/voice-engines directory is empty'
    );
    return;
  }

  const snapshot = voiceEngineSnapshotCatalog.load();
  const snapshotEngines = snapshot.engines || [];
  const snapshotIds = new Set(snapshotEngines.map((engine) => String(engine.engine_id || '')));
  let directoryRegistry: ReturnType<typeof loadVoiceEngineRegistryDirectory>;
  try {
    directoryRegistry = loadVoiceEngineRegistryDirectory(directory);
  } catch (error) {
    violations.push(
      `voice-engine-registry: canonical directory failed governed loading (${String(error)})`
    );
    return;
  }
  const directoryEngines = new Map(
    directoryRegistry.engines.map((engine) => [engine.engine_id, engine])
  );
  const directoryIds: string[] = [];

  for (const file of files) {
    const engineId = file.replace(/\.json$/i, '');
    if (!directoryEngines.has(engineId)) {
      violations.push(`voice-engine-registry/${file}: governed loader did not return this engine`);
      continue;
    }
    if (!snapshotIds.has(engineId)) {
      violations.push(`voice-engine-registry/${file}: snapshot is missing engine ${engineId}`);
    }
    directoryIds.push(engineId);
  }

  if (JSON.stringify(directoryIds.sort()) !== JSON.stringify([...snapshotIds].sort())) {
    violations.push('voice-engine-registry: snapshot and canonical directory engine ids diverge');
  }

  if (
    String(snapshot.default_engine_id || '') &&
    !snapshotIds.has(String(snapshot.default_engine_id || ''))
  ) {
    violations.push(
      'voice-engine-registry: default_engine_id must reference an engine in the canonical directory'
    );
  }
}

export function validateActuatorCatalogDirectoryConsistency(violations: string[]) {
  const catalog = loadActuatorManifestCatalog();
  if (!catalog.length) {
    violations.push(
      'global_actuator_index: libs/actuators directory has no manifest-backed actuators'
    );
    return;
  }

  const snapshot = globalActuatorIndexSnapshotCatalog.load();
  const snapshotById = new Map(
    (snapshot.actuators || []).map((entry) => [String(entry.n || ''), entry])
  );
  const catalogById = new Map(catalog.map((entry) => [entry.n, entry]));

  for (const entry of catalog) {
    if (path.basename(entry.path) !== entry.n) {
      violations.push(
        `global_actuator_index/${entry.n}: directory name mismatch (${path.basename(entry.path)} !== ${entry.n})`
      );
    }
    const snapshotEntry = snapshotById.get(entry.n);
    if (!snapshotEntry) {
      violations.push(`global_actuator_index: snapshot missing actuator ${entry.n}`);
      continue;
    }
    if (snapshotEntry.path !== entry.path) {
      violations.push(
        `global_actuator_index/${entry.n}: path mismatch (${snapshotEntry.path} !== ${entry.path})`
      );
    }
    if (snapshotEntry.d !== entry.d) {
      violations.push(`global_actuator_index/${entry.n}: description mismatch`);
    }
    if (snapshotEntry.version !== entry.version) {
      violations.push(`global_actuator_index/${entry.n}: version mismatch`);
    }
    if (snapshotEntry.capability_count !== entry.capability_count) {
      violations.push(`global_actuator_index/${entry.n}: capability_count mismatch`);
    }
    const snapshotOps = [
      ...new Set((snapshotEntry.ops || []).map((op) => String(op || '')).filter(Boolean)),
    ].sort();
    const catalogOps = [
      ...new Set((entry.ops || []).map((op) => String(op || '')).filter(Boolean)),
    ].sort();
    if (JSON.stringify(snapshotOps) !== JSON.stringify(catalogOps)) {
      violations.push(`global_actuator_index/${entry.n}: ops mismatch`);
    }
    if ((snapshotEntry.contract_schema || '') !== (entry.contract_schema || '')) {
      violations.push(`global_actuator_index/${entry.n}: contract_schema mismatch`);
    }
  }

  for (const entry of snapshot.actuators || []) {
    if (!catalogById.has(String(entry.n || ''))) {
      violations.push(
        `global_actuator_index: snapshot includes unknown actuator ${String(entry.n || '')}`
      );
    }
  }
}
