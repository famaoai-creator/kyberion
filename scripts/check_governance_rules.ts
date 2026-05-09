import * as AjvModule from 'ajv';
import * as path from 'node:path';
import { loadActuatorManifestCatalog, pathResolver, safeExistsSync, safeReaddir } from '@agent/core';
import { readJsonFile } from './refactor/cli-input.js';
import { fileURLToPath } from 'node:url';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true });

type GovernanceRuleCheck = {
  id: string;
  schemaPath: string;
  dataPath: string;
};

const GOVERNANCE_DIR = 'knowledge/public/governance';

const CHECKS: GovernanceRuleCheck[] = [
  {
    id: 'intent-policy',
    schemaPath: 'knowledge/public/schemas/intent-policy.schema.json',
    dataPath: 'knowledge/public/governance/intent-policy.json',
  },
  {
    id: 'intent-resolution-policy',
    schemaPath: 'knowledge/public/schemas/intent-resolution-policy.schema.json',
    dataPath: 'knowledge/public/governance/intent-resolution-policy.json',
  },
  {
    id: 'task-session-policy',
    schemaPath: 'knowledge/public/schemas/task-session-policy.schema.json',
    dataPath: 'knowledge/public/governance/task-session-policy.json',
  },
  {
    id: 'work-policy',
    schemaPath: 'knowledge/public/schemas/work-policy.schema.json',
    dataPath: 'knowledge/public/governance/work-policy.json',
  },
  {
    id: 'surface-policy',
    schemaPath: 'knowledge/public/schemas/surface-policy.schema.json',
    dataPath: 'knowledge/public/governance/surface-policy.json',
  },
  {
    id: 'standard-intents',
    schemaPath: 'knowledge/public/schemas/standard-intents.schema.json',
    dataPath: 'knowledge/public/governance/standard-intents.json',
  },
  {
    id: 'intent-domain-ontology',
    schemaPath: 'knowledge/public/schemas/intent-domain-ontology.schema.json',
    dataPath: 'knowledge/public/governance/intent-domain-ontology.json',
  },
  {
    id: 'intent-contract-memory',
    schemaPath: 'knowledge/public/schemas/intent-contract-memory.schema.json',
    dataPath: 'knowledge/public/governance/intent-contract-memory.json',
  },
  {
    id: 'intent-contract-selection-policy',
    schemaPath: 'knowledge/public/schemas/intent-contract-selection-policy.schema.json',
    dataPath: 'knowledge/public/governance/intent-contract-selection-policy.json',
  },
  {
    id: 'tool-actuator-routing-policy',
    schemaPath: 'knowledge/public/schemas/tool-actuator-routing-policy.schema.json',
    dataPath: 'knowledge/public/governance/tool-actuator-routing-policy.json',
  },
  {
    id: 'active-surfaces',
    schemaPath: 'knowledge/public/schemas/runtime-surface-manifest.schema.json',
    dataPath: 'knowledge/public/governance/active-surfaces.json',
  },
  {
    id: 'surface-provider-manifests',
    schemaPath: 'knowledge/public/schemas/surface-provider-manifests.schema.json',
    dataPath: 'knowledge/public/governance/surface-provider-manifests.json',
  },
  {
    id: 'surface-provider-manifest-catalog',
    schemaPath: 'knowledge/public/schemas/surface-provider-manifest-catalog.schema.json',
    dataPath: 'knowledge/public/governance/surface-provider-manifest-catalog.json',
  },
  {
    id: 'model-registry',
    schemaPath: 'knowledge/public/schemas/model-registry.schema.json',
    dataPath: 'knowledge/public/governance/model-registry.json',
  },
  {
    id: 'model-adaptation-policy',
    schemaPath: 'knowledge/public/schemas/model-adaptation-policy.schema.json',
    dataPath: 'knowledge/public/governance/model-adaptation-policy.json',
  },
  {
    id: 'harness-capability-registry',
    schemaPath: 'knowledge/public/schemas/harness-capability-registry.schema.json',
    dataPath: 'knowledge/public/governance/harness-capability-registry.json',
  },
  {
    id: 'harness-adapter-registry',
    schemaPath: 'knowledge/public/schemas/harness-adapter-registry.schema.json',
    dataPath: 'knowledge/public/governance/harness-adapter-registry.json',
  },
  {
    id: 'provider-capability-scan-policy',
    schemaPath: 'knowledge/public/schemas/provider-capability-scan-policy.schema.json',
    dataPath: 'knowledge/public/governance/provider-capability-scan-policy.json',
  },
  {
    id: 'capability-lifecycle-procedure',
    schemaPath: 'knowledge/public/schemas/capability-lifecycle-procedure.schema.json',
    dataPath: 'knowledge/public/governance/capability-lifecycle-procedure.json',
  },
  {
    id: 'execution-receipt-policy',
    schemaPath: 'knowledge/public/schemas/execution-receipt-policy.schema.json',
    dataPath: 'knowledge/public/governance/execution-receipt-policy.json',
  },
  {
    id: 'voice-profile-registry',
    schemaPath: 'knowledge/public/schemas/voice-profile-registry.schema.json',
    dataPath: 'knowledge/public/governance/voice-profile-registry.json',
  },
  {
    id: 'voice-runtime-policy',
    schemaPath: 'knowledge/public/schemas/voice-runtime-policy.schema.json',
    dataPath: 'knowledge/public/governance/voice-runtime-policy.json',
  },
  {
    id: 'voice-engine-registry',
    schemaPath: 'knowledge/public/schemas/voice-engine-registry.schema.json',
    dataPath: 'knowledge/public/governance/voice-engine-registry.json',
  },
  {
    id: 'voice-sample-ingestion-policy',
    schemaPath: 'knowledge/public/schemas/voice-sample-ingestion-policy.schema.json',
    dataPath: 'knowledge/public/governance/voice-sample-ingestion-policy.json',
  },
  {
    id: 'video-composition-template-registry',
    schemaPath: 'knowledge/public/schemas/video-composition-template-registry.schema.json',
    dataPath: 'knowledge/public/governance/video-composition-template-registry.json',
  },
  {
    id: 'video-render-runtime-policy',
    schemaPath: 'knowledge/public/schemas/video-render-runtime-policy.schema.json',
    dataPath: 'knowledge/public/governance/video-render-runtime-policy.json',
  },
  {
    id: 'mission-classification-policy',
    schemaPath: 'knowledge/public/schemas/mission-classification-policy.schema.json',
    dataPath: 'knowledge/public/governance/mission-classification-policy.json',
  },
  {
    id: 'authority-role-index',
    schemaPath: 'knowledge/public/schemas/authority-role-index.schema.json',
    dataPath: 'knowledge/public/governance/authority-role-index.json',
  },
  {
    id: 'team-role-index',
    schemaPath: 'knowledge/public/schemas/team-role-index.schema.json',
    dataPath: 'knowledge/public/orchestration/team-role-index.json',
  },
  {
    id: 'agent-profile-index',
    schemaPath: 'knowledge/public/schemas/agent-profile-index.schema.json',
    dataPath: 'knowledge/public/orchestration/agent-profile-index.json',
  },
  {
    id: 'mission-workflow-catalog',
    schemaPath: 'knowledge/public/schemas/mission-workflow-catalog.schema.json',
    dataPath: 'knowledge/public/governance/mission-workflow-catalog.json',
  },
  {
    id: 'mission-review-gate-registry',
    schemaPath: 'knowledge/public/schemas/mission-review-gate-registry.schema.json',
    dataPath: 'knowledge/public/governance/mission-review-gate-registry.json',
  },
  {
    id: 'path-scope-policy',
    schemaPath: 'knowledge/public/schemas/path-scope-policy.schema.json',
    dataPath: 'knowledge/public/governance/path-scope-policy.json',
  },
  {
    id: 'mission-orchestration-scenario-pack',
    schemaPath: 'knowledge/public/schemas/mission-orchestration-scenario-pack.schema.json',
    dataPath: 'knowledge/public/governance/mission-orchestration-scenario-pack.json',
  },
];

export function findDeterministicCatalogViolations(): string[] {
  const dir = pathResolver.rootResolve(GOVERNANCE_DIR);
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => /-deterministic\.json$/i.test(entry))
    .map((entry) => `${GOVERNANCE_DIR}/${entry}`);
}

function readJson<T>(relativePath: string): T {
  return readJsonFile<T>(pathResolver.rootResolve(relativePath));
}

function validateAgentProfileDirectoryConsistency(violations: string[]) {
  const directory = pathResolver.rootResolve('knowledge/public/orchestration/agent-profiles');
  if (!safeExistsSync(directory)) {
    violations.push('agent-profile-index: knowledge/public/orchestration/agent-profiles directory is missing');
    return;
  }

  const files = safeReaddir(directory).filter((entry) => entry.endsWith('.json')).sort();
  if (!files.length) {
    violations.push('agent-profile-index: knowledge/public/orchestration/agent-profiles directory is empty');
    return;
  }

  const schemaPath = 'knowledge/public/schemas/agent-profile-index.schema.json';
  const schema = readJson<Record<string, unknown>>(schemaPath);
  const validate = ajv.getSchema((schema as { $id?: string }).$id || schemaPath) || ajv.compile(schema);
  const snapshot = readJson<{ agents?: Record<string, unknown> }>('knowledge/public/orchestration/agent-profile-index.json');
  const snapshotAgents = snapshot.agents || {};
  const seenAgentIds = new Set<string>();

  for (const file of files) {
    const relativePath = `knowledge/public/orchestration/agent-profiles/${file}`;
    const data = readJson<Record<string, unknown>>(relativePath);
    const ok = validate(data);
    if (!ok) {
      for (const error of validate.errors || []) {
        violations.push(`agent-profile-index/${file}: ${error.instancePath || '/'} ${error.message || 'schema violation'}`);
      }
    }

    const agentIds = Object.keys((data.agents as Record<string, unknown>) || {});
    if (agentIds.length !== 1) {
      violations.push(`agent-profile-index/${file}: must contain exactly one agent profile`);
      continue;
    }

    const agentId = agentIds[0];
    if (file.replace(/\.json$/i, '') !== agentId) {
      violations.push(`agent-profile-index/${file}: file name must match agent id ${agentId}`);
    }

    if (!(agentId in snapshotAgents)) {
      violations.push(`agent-profile-index/${file}: snapshot is missing agent ${agentId}`);
    } else if (JSON.stringify((data.agents as Record<string, unknown>)[agentId]) !== JSON.stringify(snapshotAgents[agentId])) {
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

function validateVoiceProfileDirectoryConsistency(violations: string[]) {
  const directory = pathResolver.rootResolve('knowledge/public/governance/voice-profiles');
  if (!safeExistsSync(directory)) {
    violations.push('voice-profile-registry: knowledge/public/governance/voice-profiles directory is missing');
    return;
  }

  const files = safeReaddir(directory).filter((entry) => entry.endsWith('.json')).sort();
  if (!files.length) {
    violations.push('voice-profile-registry: knowledge/public/governance/voice-profiles directory is empty');
    return;
  }

  const schemaPath = 'knowledge/public/schemas/voice-profile-registry.schema.json';
  const schema = readJson<Record<string, unknown>>(schemaPath);
  const validate = ajv.getSchema((schema as { $id?: string }).$id || schemaPath) || ajv.compile(schema);
  const snapshot = readJson<{ default_profile_id?: string; profiles?: Array<{ profile_id?: string }> }>(
    'knowledge/public/governance/voice-profile-registry.json',
  );
  const snapshotProfiles = snapshot.profiles || [];
  const snapshotIds = new Set(snapshotProfiles.map((profile) => String(profile.profile_id || '')));
  const directoryIds: string[] = [];

  for (const file of files) {
    const relativePath = `knowledge/public/governance/voice-profiles/${file}`;
    const data = readJson<Record<string, unknown>>(relativePath);
    const ok = validate(data);
    if (!ok) {
      for (const error of validate.errors || []) {
        violations.push(`voice-profile-registry/${file}: ${error.instancePath || '/'} ${error.message || 'schema violation'}`);
      }
    }

    const typed = data as { profiles?: Array<{ profile_id?: string }> };
    const profileIds = (typed.profiles || []).map((profile) => String(profile.profile_id || '')).filter(Boolean);
    if (profileIds.length !== 1) {
      violations.push(`voice-profile-registry/${file}: must contain exactly one profile`);
      continue;
    }
    const profileId = profileIds[0];
    if (file.replace(/\.json$/i, '') !== profileId) {
      violations.push(`voice-profile-registry/${file}: file name must match profile id ${profileId}`);
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

  if (String(snapshot.default_profile_id || '') && !snapshotIds.has(String(snapshot.default_profile_id || ''))) {
    violations.push('voice-profile-registry: default_profile_id must reference a profile in the canonical directory');
  }
}

function validateAuthorityRoleDirectoryConsistency(violations: string[]) {
  const directory = pathResolver.rootResolve('knowledge/public/governance/authority-roles');
  if (!safeExistsSync(directory)) {
    violations.push('authority-role-index: knowledge/public/governance/authority-roles directory is missing');
    return;
  }

  const files = safeReaddir(directory).filter((entry) => entry.endsWith('.json')).sort();
  if (!files.length) {
    violations.push('authority-role-index: knowledge/public/governance/authority-roles directory is empty');
    return;
  }

  const schemaPath = 'knowledge/public/schemas/authority-role.schema.json';
  const schema = readJson<Record<string, unknown>>(schemaPath);
  const validate = ajv.getSchema((schema as { $id?: string }).$id || schemaPath) || ajv.compile(schema);
  const snapshot = readJson<{ authority_roles?: Record<string, unknown> }>(
    'knowledge/public/governance/authority-role-index.json',
  );
  const snapshotRoles = snapshot.authority_roles || {};
  const seenRoleIds = new Set<string>();

  for (const file of files) {
    const relativePath = `knowledge/public/governance/authority-roles/${file}`;
    const data = readJson<Record<string, unknown>>(relativePath);
    const ok = validate(data);
    if (!ok) {
      for (const error of validate.errors || []) {
        violations.push(`authority-role-index/${file}: ${error.instancePath || '/'} ${error.message || 'schema violation'}`);
      }
    }

    const role = String((data as { role?: string }).role || '');
    if (!role) {
      violations.push(`authority-role-index/${file}: role must not be empty`);
      continue;
    }
    if (file.replace(/\.json$/i, '') !== role) {
      violations.push(`authority-role-index/${file}: file name must match role id ${role}`);
    }

    const snapshotEntry = snapshotRoles[role];
    if (!snapshotEntry) {
      violations.push(`authority-role-index/${file}: snapshot is missing role ${role}`);
    } else {
      const { role: _role, ...dirRecord } = data as { role?: string; [key: string]: unknown };
      if (JSON.stringify(dirRecord) !== JSON.stringify(snapshotEntry)) {
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

function validateTeamRoleDirectoryConsistency(violations: string[]) {
  const directory = pathResolver.rootResolve('knowledge/public/orchestration/team-roles');
  if (!safeExistsSync(directory)) {
    violations.push('team-role-index: knowledge/public/orchestration/team-roles directory is missing');
    return;
  }

  const files = safeReaddir(directory).filter((entry) => entry.endsWith('.json')).sort();
  if (!files.length) {
    violations.push('team-role-index: knowledge/public/orchestration/team-roles directory is empty');
    return;
  }

  const schemaPath = 'knowledge/public/schemas/team-role.schema.json';
  const schema = readJson<Record<string, unknown>>(schemaPath);
  const validate = ajv.getSchema((schema as { $id?: string }).$id || schemaPath) || ajv.compile(schema);
  const snapshot = readJson<{ team_roles?: Record<string, unknown> }>('knowledge/public/orchestration/team-role-index.json');
  const snapshotRoles = snapshot.team_roles || {};
  const seenRoleIds = new Set<string>();

  for (const file of files) {
    const relativePath = `knowledge/public/orchestration/team-roles/${file}`;
    const data = readJson<Record<string, unknown>>(relativePath);
    const ok = validate(data);
    if (!ok) {
      for (const error of validate.errors || []) {
        violations.push(`team-role-index/${file}: ${error.instancePath || '/'} ${error.message || 'schema violation'}`);
      }
    }

    const role = String((data as { role?: string }).role || '');
    if (!role) {
      violations.push(`team-role-index/${file}: role must not be empty`);
      continue;
    }
    if (file.replace(/\.json$/i, '') !== role) {
      violations.push(`team-role-index/${file}: file name must match role id ${role}`);
    }

    const snapshotEntry = snapshotRoles[role];
    if (!snapshotEntry) {
      violations.push(`team-role-index/${file}: snapshot is missing role ${role}`);
    } else {
      const { role: _role, ...dirRecord } = data as { role?: string; [key: string]: unknown };
      if (JSON.stringify(dirRecord) !== JSON.stringify(snapshotEntry)) {
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

function validateSurfaceProviderCatalogDirectoryConsistency(violations: string[]) {
  const directory = pathResolver.rootResolve('knowledge/public/governance/surface-provider-manifest-catalogs');
  if (!safeExistsSync(directory)) {
    violations.push('surface-provider-manifest-catalog: knowledge/public/governance/surface-provider-manifest-catalogs directory is missing');
    return;
  }

  const files = safeReaddir(directory).filter((entry) => entry.endsWith('.json')).sort();
  if (!files.length) {
    violations.push('surface-provider-manifest-catalog: knowledge/public/governance/surface-provider-manifest-catalogs directory is empty');
    return;
  }

  const schemaPath = 'knowledge/public/schemas/surface-provider-manifest-catalog.schema.json';
  const schema = readJson<Record<string, unknown>>(schemaPath);
  const validate = ajv.getSchema((schema as { $id?: string }).$id || schemaPath) || ajv.compile(schema);
  const snapshot = readJson<{ entries?: Array<{ id?: string }> }>('knowledge/public/governance/surface-provider-manifest-catalog.json');
  const snapshotIds = new Set((snapshot.entries || []).map((entry) => String(entry.id || '')));
  const directoryIds: string[] = [];

  for (const file of files) {
    const relativePath = `knowledge/public/governance/surface-provider-manifest-catalogs/${file}`;
    const data = readJson<Record<string, unknown>>(relativePath);
    const ok = validate(data);
    if (!ok) {
      for (const error of validate.errors || []) {
        violations.push(`surface-provider-manifest-catalog/${file}: ${error.instancePath || '/'} ${error.message || 'schema violation'}`);
      }
    }

    const typed = data as { entries?: Array<{ id?: string }> };
    const ids = (typed.entries || []).map((entry) => String(entry.id || '')).filter(Boolean);
    if (ids.length !== 1) {
      violations.push(`surface-provider-manifest-catalog/${file}: must contain exactly one entry`);
      continue;
    }
    const id = ids[0];
    if (file.replace(/\.json$/i, '') !== id) {
      violations.push(`surface-provider-manifest-catalog/${file}: file name must match entry id ${id}`);
    }
    if (!snapshotIds.has(id)) {
      violations.push(`surface-provider-manifest-catalog/${file}: snapshot is missing entry ${id}`);
    }
    directoryIds.push(id);
  }

  if (JSON.stringify(directoryIds.sort()) !== JSON.stringify([...snapshotIds].sort())) {
    violations.push('surface-provider-manifest-catalog: snapshot and canonical directory entry ids diverge');
  }
}

function validateServiceEndpointsDirectoryConsistency(violations: string[]) {
  const directory = pathResolver.rootResolve('knowledge/public/orchestration/service-endpoints');
  if (!safeExistsSync(directory)) {
    violations.push('service-endpoints: knowledge/public/orchestration/service-endpoints directory is missing');
    return;
  }

  const files = safeReaddir(directory).filter((entry) => entry.endsWith('.json')).sort();
  if (!files.length) {
    violations.push('service-endpoints: knowledge/public/orchestration/service-endpoints directory is empty');
    return;
  }

  const schemaPath = 'knowledge/public/schemas/service-endpoints.schema.json';
  const schema = readJson<Record<string, unknown>>(schemaPath);
  const validate = ajv.getSchema((schema as { $id?: string }).$id || schemaPath) || ajv.compile(schema);
  const snapshot = readJson<{ default_pattern?: string; services?: Record<string, unknown> }>('knowledge/public/orchestration/service-endpoints.json');
  const snapshotIds = new Set(Object.keys(snapshot.services || {}).map((entry) => String(entry || '')));
  const directoryIds: string[] = [];

  for (const file of files) {
    const relativePath = `knowledge/public/orchestration/service-endpoints/${file}`;
    const data = readJson<Record<string, unknown>>(relativePath);
    const ok = validate(data);
    if (!ok) {
      for (const error of validate.errors || []) {
        violations.push(`service-endpoints/${file}: ${error.instancePath || '/'} ${error.message || 'schema violation'}`);
      }
    }

    const typed = data as { default_pattern?: string; services?: Record<string, unknown> };
    const ids = Object.keys(typed.services || {}).filter(Boolean);
    if (ids.length !== 1) {
      violations.push(`service-endpoints/${file}: must contain exactly one service`);
      continue;
    }

    const id = ids[0];
    if (file.replace(/\.json$/i, '') !== id) {
      violations.push(`service-endpoints/${file}: file name must match service id ${id}`);
    }
    if (typed.default_pattern !== snapshot.default_pattern) {
      violations.push(`service-endpoints/${file}: default_pattern must match the snapshot`);
    }
    if (!snapshotIds.has(id)) {
      violations.push(`service-endpoints/${file}: snapshot is missing service ${id}`);
    }
    directoryIds.push(id);
  }

  if (JSON.stringify(directoryIds.sort()) !== JSON.stringify([...snapshotIds].sort())) {
    violations.push('service-endpoints: snapshot and canonical directory service ids diverge');
  }
}

function validateSpecialistCatalogDirectoryConsistency(violations: string[]) {
  const directory = pathResolver.rootResolve('knowledge/public/orchestration/specialists');
  if (!safeExistsSync(directory)) {
    violations.push('specialist-catalog: knowledge/public/orchestration/specialists directory is missing');
    return;
  }

  const files = safeReaddir(directory).filter((entry) => entry.endsWith('.json')).sort();
  if (!files.length) {
    violations.push('specialist-catalog: knowledge/public/orchestration/specialists directory is empty');
    return;
  }

  const schemaPath = 'knowledge/public/schemas/specialist-catalog.schema.json';
  const schema = readJson<Record<string, unknown>>(schemaPath);
  const validate = ajv.getSchema((schema as { $id?: string }).$id || schemaPath) || ajv.compile(schema);
  const snapshot = readJson<{ version?: string; specialists?: Record<string, unknown> }>('knowledge/public/orchestration/specialist-catalog.json');
  const snapshotIds = new Set(Object.keys(snapshot.specialists || {}).map((entry) => String(entry || '')));
  const directoryIds: string[] = [];

  for (const file of files) {
    const relativePath = `knowledge/public/orchestration/specialists/${file}`;
    const data = readJson<Record<string, unknown>>(relativePath);
    const ok = validate(data);
    if (!ok) {
      for (const error of validate.errors || []) {
        violations.push(`specialist-catalog/${file}: ${error.instancePath || '/'} ${error.message || 'schema violation'}`);
      }
    }

    const typed = data as { version?: string; specialists?: Record<string, unknown> };
    const ids = Object.keys(typed.specialists || {}).filter(Boolean);
    if (ids.length !== 1) {
      violations.push(`specialist-catalog/${file}: must contain exactly one specialist`);
      continue;
    }

    const id = ids[0];
    if (file.replace(/\.json$/i, '') !== id) {
      violations.push(`specialist-catalog/${file}: file name must match specialist id ${id}`);
    }
    if (typed.version !== snapshot.version) {
      violations.push(`specialist-catalog/${file}: version must match the snapshot`);
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

function validateVoiceEngineDirectoryConsistency(violations: string[]) {
  const directory = pathResolver.rootResolve('knowledge/public/governance/voice-engines');
  if (!safeExistsSync(directory)) {
    violations.push('voice-engine-registry: knowledge/public/governance/voice-engines directory is missing');
    return;
  }

  const files = safeReaddir(directory).filter((entry) => entry.endsWith('.json')).sort();
  if (!files.length) {
    violations.push('voice-engine-registry: knowledge/public/governance/voice-engines directory is empty');
    return;
  }

  const schemaPath = 'knowledge/public/schemas/voice-engine-registry.schema.json';
  const schema = readJson<Record<string, unknown>>(schemaPath);
  const validate = ajv.getSchema((schema as { $id?: string }).$id || schemaPath) || ajv.compile(schema);
  const snapshot = readJson<{ default_engine_id?: string; engines?: Array<{ engine_id?: string }> }>(
    'knowledge/public/governance/voice-engine-registry.json',
  );
  const snapshotEngines = snapshot.engines || [];
  const snapshotIds = new Set(snapshotEngines.map((engine) => String(engine.engine_id || '')));
  const directoryIds: string[] = [];

  for (const file of files) {
    const relativePath = `knowledge/public/governance/voice-engines/${file}`;
    const data = readJson<Record<string, unknown>>(relativePath);
    const ok = validate(data);
    if (!ok) {
      for (const error of validate.errors || []) {
        violations.push(`voice-engine-registry/${file}: ${error.instancePath || '/'} ${error.message || 'schema violation'}`);
      }
    }

    const typed = data as { engines?: Array<{ engine_id?: string }>; default_engine_id?: string };
    const engineIds = (typed.engines || []).map((engine) => String(engine.engine_id || '')).filter(Boolean);
    if (engineIds.length !== 1) {
      violations.push(`voice-engine-registry/${file}: must contain exactly one engine`);
      continue;
    }
    const engineId = engineIds[0];
    if (file.replace(/\.json$/i, '') !== engineId) {
      violations.push(`voice-engine-registry/${file}: file name must match engine id ${engineId}`);
    }
    if (!snapshotIds.has(engineId)) {
      violations.push(`voice-engine-registry/${file}: snapshot is missing engine ${engineId}`);
    }
    directoryIds.push(engineId);
  }

  if (JSON.stringify(directoryIds.sort()) !== JSON.stringify([...snapshotIds].sort())) {
    violations.push('voice-engine-registry: snapshot and canonical directory engine ids diverge');
  }

  if (String(snapshot.default_engine_id || '') && !snapshotIds.has(String(snapshot.default_engine_id || ''))) {
    violations.push('voice-engine-registry: default_engine_id must reference an engine in the canonical directory');
  }
}

function validateActuatorCatalogDirectoryConsistency(violations: string[]) {
  const catalog = loadActuatorManifestCatalog();
  if (!catalog.length) {
    violations.push('global_actuator_index: libs/actuators directory has no manifest-backed actuators');
    return;
  }

  const snapshot = readJson<{
    actuators?: Array<{
      n?: string;
      path?: string;
      d?: string;
      version?: string;
      capability_count?: number;
      contract_schema?: string;
    }>;
  }>('knowledge/public/orchestration/global_actuator_index.json');
  const snapshotById = new Map((snapshot.actuators || []).map((entry) => [String(entry.n || ''), entry]));
  const catalogById = new Map(catalog.map((entry) => [entry.n, entry]));

  for (const entry of catalog) {
    if (path.basename(entry.path) !== entry.n) {
      violations.push(`global_actuator_index/${entry.n}: directory name mismatch (${path.basename(entry.path)} !== ${entry.n})`);
    }
    const snapshotEntry = snapshotById.get(entry.n);
    if (!snapshotEntry) {
      violations.push(`global_actuator_index: snapshot missing actuator ${entry.n}`);
      continue;
    }
    if (snapshotEntry.path !== entry.path) {
      violations.push(`global_actuator_index/${entry.n}: path mismatch (${snapshotEntry.path} !== ${entry.path})`);
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
    if ((snapshotEntry.contract_schema || '') !== (entry.contract_schema || '')) {
      violations.push(`global_actuator_index/${entry.n}: contract_schema mismatch`);
    }
  }

  for (const entry of snapshot.actuators || []) {
    if (!catalogById.has(String(entry.n || ''))) {
      violations.push(`global_actuator_index: snapshot includes unknown actuator ${String(entry.n || '')}`);
    }
  }
}

function validateRuleFile(check: GovernanceRuleCheck, violations: string[]) {
  const schema = readJson<Record<string, unknown>>(check.schemaPath);
  const data = readJson<Record<string, unknown>>(check.dataPath);
  const validate = ajv.compile(schema);
  const ok = validate(data);
  if (!ok) {
    for (const error of validate.errors || []) {
      violations.push(`${check.id}: ${error.instancePath || '/'} ${error.message || 'schema violation'}`);
    }
  }

  if (check.id === 'work-policy') {
    const typed = data as {
      specialist_routing?: { rules?: unknown[]; fallback_specialist_id?: string };
      profile_routing?: {
        defaults?: {
          execution_boundary_profile_id?: string;
          runtime_design_profile_id?: string;
        };
      };
      design_rules?: {
        process_checklist_rules?: unknown[];
        execution_shape_rules?: unknown[];
        intent_label_rules?: unknown[];
      };
    };
    if (!(typed.specialist_routing?.rules || []).length) {
      violations.push('work-policy: specialist_routing.rules must not be empty');
    }
    if (!String(typed.specialist_routing?.fallback_specialist_id || '')) {
      violations.push('work-policy: specialist_routing.fallback_specialist_id must not be empty');
    }
    if (!String(typed.profile_routing?.defaults?.execution_boundary_profile_id || '')) {
      violations.push('work-policy: profile_routing.defaults.execution_boundary_profile_id must not be empty');
    }
    if (!String(typed.profile_routing?.defaults?.runtime_design_profile_id || '')) {
      violations.push('work-policy: profile_routing.defaults.runtime_design_profile_id must not be empty');
    }
    if (!(typed.design_rules?.process_checklist_rules || []).length) {
      violations.push('work-policy: design_rules.process_checklist_rules must not be empty');
    }
    if (!(typed.design_rules?.execution_shape_rules || []).length) {
      violations.push('work-policy: design_rules.execution_shape_rules must not be empty');
    }
    if (!(typed.design_rules?.intent_label_rules || []).length) {
      violations.push('work-policy: design_rules.intent_label_rules must not be empty');
    }
  }

  if (check.id === 'intent-policy') {
    const typed = data as {
      delivery?: { rules?: Array<{ mode?: string }> };
      compiler?: {
        relevant_intent_limit?: number;
        intent_contract_rules?: unknown[];
        work_loop_rules?: unknown[];
      };
    };
    const modes = new Set((typed.delivery?.rules || []).map((rule) => String(rule.mode || '')));
    if (!modes.has('one_shot')) {
      violations.push('intent-policy: at least one one_shot delivery rule is required');
    }
    if (!modes.has('managed_program')) {
      violations.push('intent-policy: at least one managed_program delivery rule is required');
    }
    if ((typed.compiler?.relevant_intent_limit || 0) < 1) {
      violations.push('intent-policy: compiler.relevant_intent_limit must be >= 1');
    }
    if (!(typed.compiler?.intent_contract_rules || []).length) {
      violations.push('intent-policy: compiler.intent_contract_rules must not be empty');
    }
    if (!(typed.compiler?.work_loop_rules || []).length) {
      violations.push('intent-policy: compiler.work_loop_rules must not be empty');
    }
  }

  if (check.id === 'intent-resolution-policy') {
    const typed = data as {
      catalog_scoring?: {
        selected_confidence_threshold?: number;
        catalog_intent_category?: string;
      };
      legacy_candidates?: Array<{ intent_id?: string; patterns?: unknown[] }>;
    };
    if ((typed.catalog_scoring?.selected_confidence_threshold || 0) <= 0) {
      violations.push('intent-resolution-policy: catalog_scoring.selected_confidence_threshold must be > 0');
    }
    if (!String(typed.catalog_scoring?.catalog_intent_category || '')) {
      violations.push('intent-resolution-policy: catalog_scoring.catalog_intent_category must not be empty');
    }
    if (!(typed.legacy_candidates || []).length) {
      violations.push('intent-resolution-policy: legacy_candidates must not be empty');
    }
    for (const candidate of typed.legacy_candidates || []) {
      if (!String(candidate.intent_id || '')) {
        violations.push('intent-resolution-policy: every legacy candidate must define intent_id');
      }
      if (!(candidate.patterns || []).length) {
        violations.push(`intent-resolution-policy: ${String(candidate.intent_id || 'unknown')} must define patterns`);
      }
    }
  }

  if (check.id === 'task-session-policy') {
    const typed = data as {
      intents?: Array<{
        id?: string;
        task_type?: string;
        goal?: { summary?: string; success_condition?: string };
      }>;
    };
    if (!(typed.intents || []).length) {
      violations.push('task-session-policy: intents must not be empty');
    }
    for (const intent of typed.intents || []) {
      if (!String(intent.id || '')) {
        violations.push('task-session-policy: every intent must define id');
      }
      if (!String(intent.task_type || '')) {
        violations.push(`task-session-policy: ${String(intent.id || 'unknown')} must define task_type`);
      }
      if (!String(intent.goal?.summary || '')) {
        violations.push(`task-session-policy: ${String(intent.id || 'unknown')} must define goal.summary`);
      }
      if (!String(intent.goal?.success_condition || '')) {
        violations.push(`task-session-policy: ${String(intent.id || 'unknown')} must define goal.success_condition`);
      }
    }
  }

  if (check.id === 'mission-classification-policy') {
    const typed = data as {
      stage_progression?: string[];
      mission_class_rules?: unknown[];
      delivery_shape_rules?: unknown[];
      risk_profile_rules?: unknown[];
      stage_rules?: unknown[];
    };
    if (!(typed.stage_progression || []).length) {
      violations.push('mission-classification-policy: stage_progression must not be empty');
    }
    if (!(typed.mission_class_rules || []).length) {
      violations.push('mission-classification-policy: mission_class_rules must not be empty');
    }
    if (!(typed.delivery_shape_rules || []).length) {
      violations.push('mission-classification-policy: delivery_shape_rules must not be empty');
    }
    if (!(typed.risk_profile_rules || []).length) {
      violations.push('mission-classification-policy: risk_profile_rules must not be empty');
    }
    if (!(typed.stage_rules || []).length) {
      violations.push('mission-classification-policy: stage_rules must not be empty');
    }
  }

  if (check.id === 'mission-workflow-catalog') {
    const typed = data as {
      patterns?: Record<string, unknown>;
      templates?: unknown[];
      defaults?: { workflow_id?: string };
    };
    if (!String(typed.defaults?.workflow_id || '')) {
      violations.push('mission-workflow-catalog: defaults.workflow_id must not be empty');
    }
    if (!typed.patterns || !Object.keys(typed.patterns).length) {
      violations.push('mission-workflow-catalog: patterns must not be empty');
    }
    if (!(typed.templates || []).length) {
      violations.push('mission-workflow-catalog: templates must not be empty');
    }
  }

  if (check.id === 'mission-review-gate-registry') {
    const typed = data as {
      defaults?: { review_mode?: string };
      gates?: unknown[];
      mode_rules?: unknown[];
    };
    if (!String(typed.defaults?.review_mode || '')) {
      violations.push('mission-review-gate-registry: defaults.review_mode must not be empty');
    }
    if (!(typed.gates || []).length) {
      violations.push('mission-review-gate-registry: gates must not be empty');
    }
    if (!(typed.mode_rules || []).length) {
      violations.push('mission-review-gate-registry: mode_rules must not be empty');
    }
  }

  if (check.id === 'path-scope-policy') {
    const typed = data as {
      defaults?: { unknown_scope_behavior?: string };
      scope_classes?: Record<string, { allow_prefixes?: unknown[] }>;
    };
    if (!String(typed.defaults?.unknown_scope_behavior || '')) {
      violations.push('path-scope-policy: defaults.unknown_scope_behavior must not be empty');
    }
    const scopeClasses = typed.scope_classes || {};
    if (!Object.keys(scopeClasses).length) {
      violations.push('path-scope-policy: scope_classes must not be empty');
    }
    for (const [scopeClass, config] of Object.entries(scopeClasses)) {
      if (!(config.allow_prefixes || []).length) {
        violations.push(`path-scope-policy: ${scopeClass} must define allow_prefixes`);
      }
    }
  }

  if (check.id === 'mission-orchestration-scenario-pack') {
    const typed = data as {
      scenarios?: Array<{ scenario_id?: string; scenario_class?: string }>;
    };
    if (!(typed.scenarios || []).length) {
      violations.push('mission-orchestration-scenario-pack: scenarios must not be empty');
    }
    const ids = new Set<string>();
    for (const scenario of typed.scenarios || []) {
      const id = String(scenario.scenario_id || '');
      if (!id) {
        violations.push('mission-orchestration-scenario-pack: every scenario must define scenario_id');
        continue;
      }
      if (ids.has(id)) {
        violations.push(`mission-orchestration-scenario-pack: duplicated scenario_id: ${id}`);
      }
      ids.add(id);
      if (!['golden', 'controlled-failure'].includes(String(scenario.scenario_class || ''))) {
        violations.push(`mission-orchestration-scenario-pack: ${id} has invalid scenario_class`);
      }
    }
  }

  if (check.id === 'surface-provider-manifest-catalog') {
    validateSurfaceProviderCatalogDirectoryConsistency(violations);
  }

  if (check.id === 'service-endpoints') {
    validateServiceEndpointsDirectoryConsistency(violations);
  }

  if (check.id === 'voice-engine-registry') {
    validateVoiceEngineDirectoryConsistency(violations);
  }

  if (check.id === 'specialist-catalog') {
    validateSpecialistCatalogDirectoryConsistency(violations);
  }

  if (check.id === 'agent-profile-index') {
    validateAgentProfileDirectoryConsistency(violations);
  }
  if (check.id === 'standard-intents') {
    const typed = data as {
      intents?: Array<{
        id?: string;
        category?: string;
        legacy_category?: string;
        exposed_to_surface?: boolean;
        trigger_keywords?: unknown[];
      }>;
    };
    if (!(typed.intents || []).length) {
      violations.push('standard-intents: intents must not be empty');
    }
    for (const intent of typed.intents || []) {
      if (!String(intent.id || '')) {
        violations.push('standard-intents: every intent must define id');
      }
      if (!String(intent.category || '')) {
        violations.push(`standard-intents: ${String(intent.id || 'unknown')} must define category`);
      }
      if (!String(intent.legacy_category || '')) {
        violations.push(`standard-intents: ${String(intent.id || 'unknown')} must define legacy_category`);
      }
      if (typeof intent.exposed_to_surface !== 'boolean') {
        violations.push(`standard-intents: ${String(intent.id || 'unknown')} must define exposed_to_surface`);
      }
      if (!(intent.trigger_keywords || []).length) {
        violations.push(`standard-intents: ${String(intent.id || 'unknown')} must define trigger_keywords`);
      }
    }
  }

  if (check.id === 'intent-domain-ontology') {
    const typed = data as { intents?: Array<{ intent_id?: string; legacy_category?: string; category?: string }> };
    if (!(typed.intents || []).length) {
      violations.push('intent-domain-ontology: intents must not be empty');
    }
    const ids = new Set<string>();
    for (const intent of typed.intents || []) {
      const intentId = String(intent.intent_id || '');
      if (!intentId) {
        violations.push('intent-domain-ontology: every entry must define intent_id');
        continue;
      }
      if (ids.has(intentId)) {
        violations.push(`intent-domain-ontology: duplicate intent_id detected (${intentId})`);
      }
      ids.add(intentId);
      if (!String(intent.legacy_category || '')) {
        violations.push(`intent-domain-ontology: ${intentId} must define legacy_category`);
      }
      if (!String(intent.category || '')) {
        violations.push(`intent-domain-ontology: ${intentId} must define category`);
      }
    }
  }

  if (check.id === 'active-surfaces') {
    const typed = data as { surfaces?: Array<{ id?: string; enabled?: boolean }> };
    if (!(typed.surfaces || []).length) {
      violations.push('active-surfaces: surfaces must not be empty');
    }
    if (!(typed.surfaces || []).some((surface) => surface.enabled !== false)) {
      violations.push('active-surfaces: at least one surface must be enabled');
    }
    const surfacesDir = pathResolver.rootResolve('knowledge/public/governance/surfaces');
    if (safeExistsSync(surfacesDir)) {
      const directorySurfaces: Array<{ id?: string; enabled?: boolean }> = [];
      for (const entry of safeReaddir(surfacesDir).filter((name) => name.endsWith('.json')).sort()) {
        const surfaceManifest = readJson<{ version?: number; surfaces?: Array<{ id?: string; enabled?: boolean }> }>(path.join('knowledge/public/governance/surfaces', entry));
        if (!validate(surfaceManifest)) {
          for (const error of validate.errors || []) {
            violations.push(`active-surfaces:${entry}: ${error.instancePath || '/'} ${error.message || 'schema violation'}`);
          }
        }
        if (!(surfaceManifest.surfaces || []).length) {
          violations.push(`active-surfaces:${entry}: surfaces must not be empty`);
          continue;
        }
        if ((surfaceManifest.surfaces || []).length !== 1) {
          violations.push(`active-surfaces:${entry}: surface manifest files must contain exactly one surface`);
          continue;
        }
        const surface = surfaceManifest.surfaces[0];
        const expectedId = entry.replace(/\.json$/i, '');
        if (String(surface.id || '') !== expectedId) {
          violations.push(`active-surfaces:${entry}: surface id must match file name (${expectedId})`);
        }
        directorySurfaces.push(surface);
      }
      const sortById = (items: Array<{ id?: string }>) => [...items].sort((left, right) => String(left.id || '').localeCompare(String(right.id || '')));
      const snapshotIds = JSON.stringify(sortById(typed.surfaces || []));
      const directoryIds = JSON.stringify(sortById(directorySurfaces));
      if (snapshotIds !== directoryIds) {
        violations.push('active-surfaces: compatibility snapshot must match knowledge/public/governance/surfaces/*.json');
      }
    }
  }

  if (check.id === 'model-registry') {
    const typed = data as {
      default_model_id?: string;
      models?: Array<{ model_id?: string; status?: string }>;
    };
    if (!(typed.models || []).length) {
      violations.push('model-registry: models must not be empty');
      return;
    }
    const modelIds = new Set<string>();
    for (const model of typed.models || []) {
      const modelId = String(model.model_id || '');
      if (!modelId) {
        violations.push('model-registry: every model must define model_id');
        continue;
      }
      if (modelIds.has(modelId)) {
        violations.push(`model-registry: duplicate model_id detected (${modelId})`);
      }
      modelIds.add(modelId);
    }
    if (!typed.default_model_id) {
      violations.push('model-registry: default_model_id must not be empty');
      return;
    }
    const defaultModel = (typed.models || []).find((model) => model.model_id === typed.default_model_id);
    if (!defaultModel) {
      violations.push('model-registry: default_model_id must reference an existing model_id');
      return;
    }
    if (defaultModel.status !== 'approved') {
      violations.push('model-registry: default_model_id must point to an approved model');
    }
    if (!(typed.models || []).some((model) => model.status === 'candidate')) {
      violations.push('model-registry: at least one candidate model is required for shadow adaptation');
    }
  }

  if (check.id === 'model-adaptation-policy') {
    const typed = data as {
      lifecycle?: { steps?: string[] };
      benchmark_suites?: Array<{ id?: string }>;
      promotion_gates?: { required_suites?: string[] };
      integration_decision_rules?: Array<{ id?: string }>;
      rollback?: { min_signal_count?: number };
    };
    const lifecycleSteps = typed.lifecycle?.steps || [];
    const requiredLifecycleSteps = ['detect', 'profile', 'evaluate', 'adapt', 'shadow', 'promote_or_rollback'];
    for (const step of requiredLifecycleSteps) {
      if (!lifecycleSteps.includes(step)) {
        violations.push(`model-adaptation-policy: lifecycle.steps must include ${step}`);
      }
    }
    const benchmarkIds = new Set((typed.benchmark_suites || []).map((suite) => String(suite.id || '')));
    if (!benchmarkIds.size) {
      violations.push('model-adaptation-policy: benchmark_suites must not be empty');
    }
    for (const suiteId of typed.promotion_gates?.required_suites || []) {
      if (!benchmarkIds.has(suiteId)) {
        violations.push(`model-adaptation-policy: promotion_gates.required_suites contains unknown suite id (${suiteId})`);
      }
    }
    const decisionRuleIds = new Set<string>();
    for (const rule of typed.integration_decision_rules || []) {
      const id = String(rule.id || '');
      if (!id) {
        violations.push('model-adaptation-policy: every integration_decision_rule must define id');
        continue;
      }
      if (decisionRuleIds.has(id)) {
        violations.push(`model-adaptation-policy: duplicate integration_decision_rule id (${id})`);
      }
      decisionRuleIds.add(id);
    }
    if ((typed.rollback?.min_signal_count || 0) < 1) {
      violations.push('model-adaptation-policy: rollback.min_signal_count must be >= 1');
    }
  }

  if (check.id === 'harness-capability-registry') {
    const typed = data as {
      capabilities?: Array<{
        capability_id?: string;
        status?: string;
        fallback_path?: { mode?: string; target?: string };
      }>;
    };
    if (!(typed.capabilities || []).length) {
      violations.push('harness-capability-registry: capabilities must not be empty');
      return;
    }
    const capabilityIds = new Set<string>();
    for (const capability of typed.capabilities || []) {
      const capabilityId = String(capability.capability_id || '');
      if (!capabilityId) {
        violations.push('harness-capability-registry: every capability must define capability_id');
        continue;
      }
      if (capabilityIds.has(capabilityId)) {
        violations.push(`harness-capability-registry: duplicate capability_id detected (${capabilityId})`);
      }
      capabilityIds.add(capabilityId);

      if (capability.status === 'active' && capability.fallback_path?.mode !== 'none' && !String(capability.fallback_path?.target || '')) {
        violations.push(`harness-capability-registry: active capability ${capabilityId} must define fallback_path.target when fallback is enabled`);
      }
    }
    if (!(typed.capabilities || []).some((capability) => capability.status === 'active')) {
      violations.push('harness-capability-registry: at least one active capability is required');
    }
  }

  if (check.id === 'harness-adapter-registry') {
    const typed = data as {
      profiles?: Array<{
        adapter_id?: string;
        enabled?: boolean;
        fallback_contract?: string;
        capability_id?: string;
      }>;
    };
    if (!(typed.profiles || []).length) {
      violations.push('harness-adapter-registry: profiles must not be empty');
      return;
    }
    const adapterIds = new Set<string>();
    for (const profile of typed.profiles || []) {
      const adapterId = String(profile.adapter_id || '');
      if (!adapterId) {
        violations.push('harness-adapter-registry: every profile must define adapter_id');
        continue;
      }
      if (adapterIds.has(adapterId)) {
        violations.push(`harness-adapter-registry: duplicate adapter_id detected (${adapterId})`);
      }
      adapterIds.add(adapterId);

      if (profile.enabled && !String(profile.fallback_contract || '')) {
        violations.push(`harness-adapter-registry: enabled adapter ${adapterId} must define fallback_contract`);
      }
      if (!String(profile.capability_id || '')) {
        violations.push(`harness-adapter-registry: adapter ${adapterId} must define capability_id`);
      }
    }
    if (!(typed.profiles || []).some((profile) => profile.enabled)) {
      violations.push('harness-adapter-registry: at least one enabled profile is required');
    }
  }

  if (check.id === 'provider-capability-scan-policy') {
    const typed = data as {
      providers?: Array<{
        provider?: string;
        primary_probe?: {
          command?: string;
        };
        evidence_probes?: Array<{
          capability_ids?: string[];
          probe?: {
            command?: string;
          };
        }>;
      }>;
    };
    if (!(typed.providers || []).length) {
      violations.push('provider-capability-scan-policy: providers must not be empty');
      return;
    }
    const providerNames = new Set<string>();
    for (const provider of typed.providers || []) {
      const providerName = String(provider.provider || '');
      if (!providerName) {
        violations.push('provider-capability-scan-policy: every provider must define provider');
        continue;
      }
      if (providerNames.has(providerName)) {
        violations.push(`provider-capability-scan-policy: duplicate provider detected (${providerName})`);
      }
      providerNames.add(providerName);
      if (!String(provider.primary_probe?.command || '')) {
        violations.push(`provider-capability-scan-policy: provider ${providerName} must define primary_probe.command`);
      }
      for (const evidenceProbe of provider.evidence_probes || []) {
        if (!String(evidenceProbe.probe?.command || '')) {
          violations.push(`provider-capability-scan-policy: provider ${providerName} evidence probe must define probe.command`);
        }
        if (!(evidenceProbe.capability_ids || []).length) {
          violations.push(`provider-capability-scan-policy: provider ${providerName} evidence probe must define capability_ids`);
        }
      }
    }
  }

  if (check.id === 'execution-receipt-policy') {
    const typed = data as {
      required_sections?: string[];
      clarification?: {
        max_blocking_questions_per_turn?: number;
        must_explain_missing_inputs?: boolean;
      };
      compactness?: {
        max_interpreted_goal_chars?: number;
        max_next_action_chars?: number;
      };
      approval_binding?: {
        require_policy_refs_when_approval_required?: boolean;
        require_reason_when_approval_required?: boolean;
      };
      routing_binding?: {
        allowed_modes?: string[];
        allowed_routing?: string[];
      };
    };
    const requiredSections = new Set(typed.required_sections || []);
    for (const key of ['intent', 'deliverable', 'missing_inputs', 'approval', 'execution', 'status']) {
      if (!requiredSections.has(key)) {
        violations.push(`execution-receipt-policy: required_sections must include ${key}`);
      }
    }
    if ((typed.clarification?.max_blocking_questions_per_turn || 0) > 3) {
      violations.push('execution-receipt-policy: clarification.max_blocking_questions_per_turn must be <= 3');
    }
    if ((typed.compactness?.max_next_action_chars || 0) > (typed.compactness?.max_interpreted_goal_chars || 0)) {
      violations.push('execution-receipt-policy: compactness.max_next_action_chars must be <= compactness.max_interpreted_goal_chars');
    }
    if (
      typed.approval_binding?.require_policy_refs_when_approval_required &&
      !typed.approval_binding?.require_reason_when_approval_required
    ) {
      violations.push(
        'execution-receipt-policy: approval reason is required when policy refs are required for approval'
      );
    }
    if (!(typed.routing_binding?.allowed_modes || []).length) {
      violations.push('execution-receipt-policy: routing_binding.allowed_modes must not be empty');
    }
    if (!(typed.routing_binding?.allowed_routing || []).length) {
      violations.push('execution-receipt-policy: routing_binding.allowed_routing must not be empty');
    }
  }

  if (check.id === 'voice-profile-registry') {
    const typed = data as {
      default_profile_id?: string;
      profiles?: Array<{
        profile_id?: string;
        status?: string;
        languages?: string[];
        tier?: string;
        default_engine_id?: string;
      }>;
    };
    if (!(typed.profiles || []).length) {
      violations.push('voice-profile-registry: profiles must not be empty');
      return;
    }
    const profileIds = new Set<string>();
    for (const profile of typed.profiles || []) {
      const profileId = String(profile.profile_id || '');
      if (!profileId) {
        violations.push('voice-profile-registry: every profile must define profile_id');
        continue;
      }
      if (profileIds.has(profileId)) {
        violations.push(`voice-profile-registry: duplicate profile_id detected (${profileId})`);
      }
      profileIds.add(profileId);
      if (!(profile.languages || []).length) {
        violations.push(`voice-profile-registry: ${profileId} must define at least one language`);
      }
      if (!String(profile.tier || '')) {
        violations.push(`voice-profile-registry: ${profileId} must define tier`);
      }
      if (!String(profile.default_engine_id || '')) {
        violations.push(`voice-profile-registry: ${profileId} must define default_engine_id`);
      }
    }
    if (!String(typed.default_profile_id || '')) {
      violations.push('voice-profile-registry: default_profile_id must not be empty');
      return;
    }
    if (!profileIds.has(String(typed.default_profile_id || ''))) {
      violations.push('voice-profile-registry: default_profile_id must reference an existing profile_id');
    }
    if (!(typed.profiles || []).some((profile) => profile.status === 'active')) {
      violations.push('voice-profile-registry: at least one active profile is required');
    }

    const engineRegistry = readJson<{ engines?: Array<{ engine_id?: string }> }>(
      'knowledge/public/governance/voice-engine-registry.json'
    );
    const engineIds = new Set((engineRegistry.engines || []).map((engine) => String(engine.engine_id || '')));
    for (const profile of typed.profiles || []) {
      const profileId = String(profile.profile_id || 'unknown');
      const engineId = String(profile.default_engine_id || '');
      if (engineId && !engineIds.has(engineId)) {
        violations.push(`voice-profile-registry: ${profileId} references unknown default_engine_id (${engineId})`);
      }
    }
    validateVoiceProfileDirectoryConsistency(violations);
  }

  if (check.id === 'authority-role-index') {
    const typed = data as {
      authority_roles?: Record<string, unknown>;
    };
    if (!Object.keys(typed.authority_roles || {}).length) {
      violations.push('authority-role-index: authority_roles must not be empty');
      return;
    }
    validateAuthorityRoleDirectoryConsistency(violations);
  }

  if (check.id === 'team-role-index') {
    validateTeamRoleDirectoryConsistency(violations);
  }

  if (check.id === 'voice-runtime-policy') {
    const typed = data as {
      queue?: { concurrency?: number; cancellation?: string };
      chunking?: {
        default_max_chunk_chars?: number;
        default_crossfade_ms?: number;
      };
      progress?: { throttle_ms?: number; min_percent_delta?: number };
      routing?: {
        default_personal_voice_mode?: string;
        enforce_clone_engine_for_personal_tier?: boolean;
      };
    };
    if ((typed.queue?.concurrency || 0) < 1) {
      violations.push('voice-runtime-policy: queue.concurrency must be >= 1');
    }
    if ((typed.chunking?.default_max_chunk_chars || 0) < 100) {
      violations.push('voice-runtime-policy: chunking.default_max_chunk_chars must be >= 100');
    }
    if ((typed.chunking?.default_crossfade_ms || 0) > 500) {
      violations.push('voice-runtime-policy: chunking.default_crossfade_ms must be <= 500');
    }
    if ((typed.progress?.throttle_ms || 0) < 50) {
      violations.push('voice-runtime-policy: progress.throttle_ms must be >= 50');
    }
    if ((typed.progress?.min_percent_delta || 0) < 0) {
      violations.push('voice-runtime-policy: progress.min_percent_delta must be >= 0');
    }
    if (!['allow_fallback', 'require_personal_voice'].includes(String(typed.routing?.default_personal_voice_mode || ''))) {
      violations.push('voice-runtime-policy: routing.default_personal_voice_mode must be allow_fallback or require_personal_voice');
    }
    if (typed.routing?.enforce_clone_engine_for_personal_tier === undefined) {
      violations.push('voice-runtime-policy: routing.enforce_clone_engine_for_personal_tier must be defined');
    }
  }

  if (check.id === 'voice-engine-registry') {
    const typed = data as {
      default_engine_id?: string;
      engines?: Array<{
        engine_id?: string;
        status?: string;
        fallback_engine_id?: string;
        supports?: { playback?: boolean; artifact_formats?: string[] };
      }>;
    };
    if (!(typed.engines || []).length) {
      violations.push('voice-engine-registry: engines must not be empty');
      return;
    }
    const engineIds = new Set<string>();
    for (const engine of typed.engines || []) {
      const engineId = String(engine.engine_id || '');
      if (!engineId) {
        violations.push('voice-engine-registry: every engine must define engine_id');
        continue;
      }
      if (engineIds.has(engineId)) {
        violations.push(`voice-engine-registry: duplicate engine_id detected (${engineId})`);
      }
      engineIds.add(engineId);
      if (engine.supports?.playback === false && (engine.supports?.artifact_formats || []).length === 0) {
        violations.push(`voice-engine-registry: ${engineId} must support playback or at least one artifact format`);
      }
    }
    if (!String(typed.default_engine_id || '')) {
      violations.push('voice-engine-registry: default_engine_id must not be empty');
      return;
    }
    if (!engineIds.has(String(typed.default_engine_id || ''))) {
      violations.push('voice-engine-registry: default_engine_id must reference an existing engine_id');
    }
    if (!(typed.engines || []).some((engine) => engine.status === 'active')) {
      violations.push('voice-engine-registry: at least one active engine is required');
    }
    for (const engine of typed.engines || []) {
      const engineId = String(engine.engine_id || '');
      const fallbackId = String(engine.fallback_engine_id || '');
      if (fallbackId && !engineIds.has(fallbackId)) {
        violations.push(`voice-engine-registry: ${engineId} references unknown fallback_engine_id (${fallbackId})`);
      }
      if (fallbackId && fallbackId === engineId) {
        violations.push(`voice-engine-registry: ${engineId} must not reference itself as fallback_engine_id`);
      }
    }
  }

  if (check.id === 'voice-sample-ingestion-policy') {
    const typed = data as {
      sample_limits?: {
        min_samples?: number;
        max_samples?: number;
        min_sample_bytes?: number;
        max_sample_bytes?: number;
        allowed_extensions?: string[];
      };
      profile_rules?: {
        allowed_tiers?: string[];
        require_unique_sample_paths?: boolean;
        require_language_coverage?: boolean;
      };
    };
    if ((typed.sample_limits?.min_samples || 0) < 1) {
      violations.push('voice-sample-ingestion-policy: sample_limits.min_samples must be >= 1');
    }
    if ((typed.sample_limits?.max_samples || 0) < (typed.sample_limits?.min_samples || 0)) {
      violations.push('voice-sample-ingestion-policy: sample_limits.max_samples must be >= sample_limits.min_samples');
    }
    if ((typed.sample_limits?.min_sample_bytes || 0) < 1024) {
      violations.push('voice-sample-ingestion-policy: sample_limits.min_sample_bytes must be >= 1024');
    }
    if ((typed.sample_limits?.max_sample_bytes || 0) < (typed.sample_limits?.min_sample_bytes || 0)) {
      violations.push('voice-sample-ingestion-policy: sample_limits.max_sample_bytes must be >= sample_limits.min_sample_bytes');
    }
    if (!(typed.sample_limits?.allowed_extensions || []).length) {
      violations.push('voice-sample-ingestion-policy: sample_limits.allowed_extensions must not be empty');
    }
    if (!(typed.profile_rules?.allowed_tiers || []).length) {
      violations.push('voice-sample-ingestion-policy: profile_rules.allowed_tiers must not be empty');
    }
    if (typed.profile_rules?.require_unique_sample_paths === undefined) {
      violations.push('voice-sample-ingestion-policy: profile_rules.require_unique_sample_paths must be defined');
    }
    if (typed.profile_rules?.require_language_coverage === undefined) {
      violations.push('voice-sample-ingestion-policy: profile_rules.require_language_coverage must be defined');
    }
  }

  if (check.id === 'video-composition-template-registry') {
    const typed = data as {
      default_template_id?: string;
      templates?: Array<{
        template_id?: string;
        status?: string;
        supported_roles?: string[];
        required_content_fields?: string[];
        supported_output_formats?: string[];
      }>;
    };
    if (!(typed.templates || []).length) {
      violations.push('video-composition-template-registry: templates must not be empty');
      return;
    }
    const templateIds = new Set<string>();
    for (const template of typed.templates || []) {
      const templateId = String(template.template_id || '');
      if (!templateId) {
        violations.push('video-composition-template-registry: every template must define template_id');
        continue;
      }
      if (templateIds.has(templateId)) {
        violations.push(`video-composition-template-registry: duplicate template_id detected (${templateId})`);
      }
      templateIds.add(templateId);
      if (!(template.supported_roles || []).length) {
        violations.push(`video-composition-template-registry: ${templateId} must define supported_roles`);
      }
      if (!(template.required_content_fields || []).length) {
        violations.push(`video-composition-template-registry: ${templateId} must define required_content_fields`);
      }
      if (!(template.supported_output_formats || []).length) {
        violations.push(`video-composition-template-registry: ${templateId} must define supported_output_formats`);
      }
    }
    if (!String(typed.default_template_id || '')) {
      violations.push('video-composition-template-registry: default_template_id must not be empty');
      return;
    }
    if (!templateIds.has(String(typed.default_template_id || ''))) {
      violations.push('video-composition-template-registry: default_template_id must reference an existing template_id');
    }
    if (!(typed.templates || []).some((template) => template.status === 'active')) {
      violations.push('video-composition-template-registry: at least one active template is required');
    }
  }

  if (check.id === 'video-render-runtime-policy') {
    const typed = data as {
      queue?: { concurrency?: number };
      progress?: { throttle_ms?: number; min_percent_delta?: number };
      bundle?: { default_bundle_root?: string };
      render?: {
        allowed_output_formats?: string[];
        backend?: string;
        quality?: string;
        command_timeout_ms?: number;
      };
    };
    if ((typed.queue?.concurrency || 0) < 1) {
      violations.push('video-render-runtime-policy: queue.concurrency must be >= 1');
    }
    if ((typed.progress?.throttle_ms || 0) < 50) {
      violations.push('video-render-runtime-policy: progress.throttle_ms must be >= 50');
    }
    if ((typed.progress?.min_percent_delta || 0) < 0) {
      violations.push('video-render-runtime-policy: progress.min_percent_delta must be >= 0');
    }
    if (!String(typed.bundle?.default_bundle_root || '')) {
      violations.push('video-render-runtime-policy: bundle.default_bundle_root must not be empty');
    }
    if (!(typed.render?.allowed_output_formats || []).length) {
      violations.push('video-render-runtime-policy: render.allowed_output_formats must not be empty');
    }
    if (!['none', 'hyperframes_cli'].includes(String(typed.render?.backend || ''))) {
      violations.push('video-render-runtime-policy: render.backend must be one of none|hyperframes_cli');
    }
    if (!['draft', 'standard', 'high'].includes(String(typed.render?.quality || ''))) {
      violations.push('video-render-runtime-policy: render.quality must be one of draft|standard|high');
    }
    if ((typed.render?.command_timeout_ms || 0) < 1000) {
      violations.push('video-render-runtime-policy: render.command_timeout_ms must be >= 1000');
    }
  }

}

export function main() {
  const violations: string[] = [];
  for (const check of CHECKS) {
    validateRuleFile(check, violations);
  }
  validateActuatorCatalogDirectoryConsistency(violations);
  for (const deterministicCatalog of findDeterministicCatalogViolations()) {
    violations.push(
      `governance-catalog: deterministic catalog must be removed or migrated (${deterministicCatalog})`
    );
  }

  if (violations.length > 0) {
    console.error('[check:governance-rules] violations detected:');
    for (const violation of violations.sort()) {
      console.error(`- ${violation}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('[check:governance-rules] OK');
}

const isDirectRun = process.argv[1] && pathResolver.rootResolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main();
}
