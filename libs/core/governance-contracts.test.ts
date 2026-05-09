import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { loadActuatorManifestCatalog } from './index.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeExistsSync, safeReadFile, safeReaddir } from './secure-io.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

type GovernanceSchemaCase = {
  name: string;
  schemaPath: string;
  dataPath: string;
  invalidPayload: unknown;
};

function readPayloadsFromDir(relativeDir: string): unknown[] {
  const dir = path.resolve(process.cwd(), relativeDir);
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => JSON.parse(safeReadFile(path.join(dir, entry), { encoding: 'utf8' }) as string));
}

const CASES: GovernanceSchemaCase[] = [
  {
    name: 'intent-policy',
    schemaPath: 'knowledge/public/schemas/intent-policy.schema.json',
    dataPath: 'knowledge/public/governance/intent-policy.json',
    invalidPayload: {
      version: '1.0.0',
      delivery: { rules: [] },
    },
  },
  {
    name: 'active-surfaces',
    schemaPath: 'knowledge/public/schemas/runtime-surface-manifest.schema.json',
    dataPath: 'knowledge/public/governance/active-surfaces.json',
    invalidPayload: { version: 1 },
  },
  {
    name: 'model-registry',
    schemaPath: 'knowledge/public/schemas/model-registry.schema.json',
    dataPath: 'knowledge/public/governance/model-registry.json',
    invalidPayload: {
      version: '1.0.0',
      default_model_id: 'openai:gpt-5.4',
    },
  },
  {
    name: 'model-adaptation-policy',
    schemaPath: 'knowledge/public/schemas/model-adaptation-policy.schema.json',
    dataPath: 'knowledge/public/governance/model-adaptation-policy.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'harness-capability-registry',
    schemaPath: 'knowledge/public/schemas/harness-capability-registry.schema.json',
    dataPath: 'knowledge/public/governance/harness-capability-registry.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'capability-bundle-registry',
    schemaPath: 'knowledge/public/schemas/capability-bundle-registry.schema.json',
    dataPath: 'knowledge/public/governance/capability-bundle-registry.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'execution-receipt-policy',
    schemaPath: 'knowledge/public/schemas/execution-receipt-policy.schema.json',
    dataPath: 'knowledge/public/governance/execution-receipt-policy.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'voice-profile-registry',
    schemaPath: 'knowledge/public/schemas/voice-profile-registry.schema.json',
    dataPath: 'knowledge/public/governance/voice-profile-registry.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'voice-profile-directory',
    schemaPath: 'knowledge/public/schemas/voice-profile-registry.schema.json',
    dataPath: 'knowledge/public/governance/voice-profiles/operator-en-default.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'voice-runtime-policy',
    schemaPath: 'knowledge/public/schemas/voice-runtime-policy.schema.json',
    dataPath: 'knowledge/public/governance/voice-runtime-policy.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'voice-engine-registry',
    schemaPath: 'knowledge/public/schemas/voice-engine-registry.schema.json',
    dataPath: 'knowledge/public/governance/voice-engine-registry.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'voice-sample-ingestion-policy',
    schemaPath: 'knowledge/public/schemas/voice-sample-ingestion-policy.schema.json',
    dataPath: 'knowledge/public/governance/voice-sample-ingestion-policy.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'video-composition-template-registry',
    schemaPath: 'knowledge/public/schemas/video-composition-template-registry.schema.json',
    dataPath: 'knowledge/public/governance/video-composition-template-registry.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'video-render-runtime-policy',
    schemaPath: 'knowledge/public/schemas/video-render-runtime-policy.schema.json',
    dataPath: 'knowledge/public/governance/video-render-runtime-policy.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'mission-classification-policy',
    schemaPath: 'knowledge/public/schemas/mission-classification-policy.schema.json',
    dataPath: 'knowledge/public/governance/mission-classification-policy.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'authority-role-index',
    schemaPath: 'knowledge/public/schemas/authority-role-index.schema.json',
    dataPath: 'knowledge/public/governance/authority-role-index.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'authority-role-directory',
    schemaPath: 'knowledge/public/schemas/authority-role.schema.json',
    dataPath: 'knowledge/public/governance/authority-roles/mission_controller.json',
    invalidPayload: {
      description: 'Mission lifecycle authority with mission state and observability write access.',
    },
  },
  {
    name: 'team-role-index',
    schemaPath: 'knowledge/public/schemas/team-role-index.schema.json',
    dataPath: 'knowledge/public/orchestration/team-role-index.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'team-role-directory',
    schemaPath: 'knowledge/public/schemas/team-role.schema.json',
    dataPath: 'knowledge/public/orchestration/team-roles/owner.json',
    invalidPayload: {
      description: 'Mission owner with final accountability, checkpoint, verify, and finish authority.',
    },
  },
  {
    name: 'agent-profile-index',
    schemaPath: 'knowledge/public/schemas/agent-profile-index.schema.json',
    dataPath: 'knowledge/public/orchestration/agent-profile-index.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'mission-workflow-catalog',
    schemaPath: 'knowledge/public/schemas/mission-workflow-catalog.schema.json',
    dataPath: 'knowledge/public/governance/mission-workflow-catalog.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'mission-review-gate-registry',
    schemaPath: 'knowledge/public/schemas/mission-review-gate-registry.schema.json',
    dataPath: 'knowledge/public/governance/mission-review-gate-registry.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'path-scope-policy',
    schemaPath: 'knowledge/public/schemas/path-scope-policy.schema.json',
    dataPath: 'knowledge/public/governance/path-scope-policy.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'mission-orchestration-scenario-pack',
    schemaPath: 'knowledge/public/schemas/mission-orchestration-scenario-pack.schema.json',
    dataPath: 'knowledge/public/governance/mission-orchestration-scenario-pack.json',
    invalidPayload: { version: '1.0.0' },
  },
  {
    name: 'operator-learning-scenario-pack',
    schemaPath: 'knowledge/public/schemas/operator-learning-scenario-pack.schema.json',
    dataPath: 'knowledge/public/governance/operator-learning-scenario-pack.json',
    invalidPayload: {
      version: '1.0.0',
      scenarios: [],
    },
  },
  {
    name: 'operator-learning-dispatch-registry',
    schemaPath: 'knowledge/public/schemas/operator-learning-dispatch-registry.schema.json',
    dataPath: 'knowledge/public/governance/operator-learning-dispatch-registry.json',
    invalidPayload: {
      version: '1.0.0',
      rules: [],
    },
  },
  {
    name: 'presentation-preference-registry',
    schemaPath: 'knowledge/public/schemas/presentation-preference-registry.schema.json',
    dataPath: 'knowledge/public/governance/presentation-preference-registry.json',
    invalidPayload: {
      version: '1.0.0',
      default_profile_id: 'business-deck-default',
      profiles: [],
    },
  },
  {
    name: 'surface-query-overlay-catalog',
    schemaPath: 'knowledge/public/schemas/surface-query-overlay-catalog.schema.json',
    dataPath: 'knowledge/public/governance/surface-query-overlay-catalog.json',
    invalidPayload: {
      version: '1.0.0',
      base_config_path: 'public/presence/surface-query-providers.json',
      overlays: [{ id: 'missing-path', kind: 'role' }],
    },
  },
  {
    name: 'surface-provider-manifest-catalog',
    schemaPath: 'knowledge/public/schemas/surface-provider-manifest-catalog.schema.json',
    dataPath: 'knowledge/public/governance/surface-provider-manifest-catalog.json',
    invalidPayload: {
      version: '1.0.0',
      entries: [{ id: 'slack', channel: 'slack' }],
    },
  },
  {
    name: 'surface-provider-manifest-catalog-directory',
    schemaPath: 'knowledge/public/schemas/surface-provider-manifest-catalog.schema.json',
    dataPath: 'knowledge/public/governance/surface-provider-manifest-catalogs/slack.json',
    invalidPayload: {
      version: '1.0.0',
      entries: [{ id: 'slack', channel: 'slack' }],
    },
  },
  {
    name: 'service-endpoints',
    schemaPath: 'knowledge/public/schemas/service-endpoints.schema.json',
    dataPath: 'knowledge/public/orchestration/service-endpoints.json',
    invalidPayload: {
      default_pattern: 'https://api.{service_id}.com/v1',
      services: {
        broken: {},
      },
    },
  },
  {
    name: 'service-endpoints-directory',
    schemaPath: 'knowledge/public/schemas/service-endpoints.schema.json',
    dataPath: 'knowledge/public/orchestration/service-endpoints/slack.json',
    invalidPayload: {
      default_pattern: 'https://api.{service_id}.com/v1',
      services: {
        slack: {},
      },
    },
  },
  {
    name: 'specialist-catalog',
    schemaPath: 'knowledge/public/schemas/specialist-catalog.schema.json',
    dataPath: 'knowledge/public/orchestration/specialist-catalog.json',
    invalidPayload: {
      version: '1.0.0',
      specialists: {
        broken: {},
      },
    },
  },
  {
    name: 'specialist-catalog-directory',
    schemaPath: 'knowledge/public/schemas/specialist-catalog.schema.json',
    dataPath: 'knowledge/public/orchestration/specialists/document-specialist.json',
    invalidPayload: {
      version: '1.0.0',
      specialists: {
        broken: {},
      },
    },
  },
  {
    name: 'tool-actuator-routing-policy',
    schemaPath: 'knowledge/public/schemas/tool-actuator-routing-policy.schema.json',
    dataPath: 'knowledge/public/governance/tool-actuator-routing-policy.json',
    invalidPayload: {
      version: '1.0.0',
      defaults: { fallback_actuator: 'orchestrator-actuator' },
      tool_routes: [],
    },
  },
];

describe('governance contracts', () => {
  for (const testCase of CASES) {
    it(`accepts ${testCase.name}`, () => {
      const root = process.cwd();
      const ajv = new AjvCtor({ allErrors: true });
      addFormats(ajv);
      const validate = compileSchemaFromPath(ajv, path.resolve(root, testCase.schemaPath));
      const payload = JSON.parse(
        safeReadFile(path.resolve(root, testCase.dataPath), { encoding: 'utf8' }) as string,
      );

      expect(validate(payload)).toBe(true);
    });

    it(`rejects invalid ${testCase.name} payloads`, () => {
      const root = process.cwd();
      const ajv = new AjvCtor({ allErrors: true });
      addFormats(ajv);
      const validate = compileSchemaFromPath(ajv, path.resolve(root, testCase.schemaPath));

      expect(validate(testCase.invalidPayload)).toBe(false);
    });
  }

  it('keeps the canonical voice profile and surface provider directories aligned with their snapshots', () => {
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);

    const voiceSchema = compileSchemaFromPath(
      ajv,
      path.resolve(process.cwd(), 'knowledge/public/schemas/voice-profile-registry.schema.json'),
    );
    const voiceSnapshot = JSON.parse(
      safeReadFile(path.resolve(process.cwd(), 'knowledge/public/governance/voice-profile-registry.json'), { encoding: 'utf8' }) as string,
    );
    const voiceDirPayloads = readPayloadsFromDir('knowledge/public/governance/voice-profiles');
    expect(voiceDirPayloads.length).toBeGreaterThan(0);
    for (const payload of voiceDirPayloads) {
      expect(voiceSchema(payload)).toBe(true);
    }
    expect(
      voiceDirPayloads.map((payload) => (payload as { profiles?: Array<{ profile_id?: string }> }).profiles?.[0]?.profile_id).sort(),
    ).toEqual((voiceSnapshot.profiles || []).map((profile: { profile_id?: string }) => profile.profile_id).sort());

    const providerSchema = compileSchemaFromPath(
      ajv,
      path.resolve(process.cwd(), 'knowledge/public/schemas/surface-provider-manifest-catalog.schema.json'),
    );
    const providerSnapshot = JSON.parse(
      safeReadFile(path.resolve(process.cwd(), 'knowledge/public/governance/surface-provider-manifest-catalog.json'), { encoding: 'utf8' }) as string,
    );
    const providerDirPayloads = readPayloadsFromDir('knowledge/public/governance/surface-provider-manifest-catalogs');
    expect(providerDirPayloads.length).toBeGreaterThan(0);
    for (const payload of providerDirPayloads) {
      expect(providerSchema(payload)).toBe(true);
    }
    expect(
      providerDirPayloads.map((payload) => (payload as { entries?: Array<{ id?: string }> }).entries?.[0]?.id).sort(),
    ).toEqual((providerSnapshot.entries || []).map((entry: { id?: string }) => entry.id).sort());
  });

  it('keeps the canonical authority role directory aligned with the snapshot', () => {
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);

    const authoritySchema = compileSchemaFromPath(
      ajv,
      path.resolve(process.cwd(), 'knowledge/public/schemas/authority-role.schema.json'),
    );
    const authoritySnapshot = JSON.parse(
      safeReadFile(path.resolve(process.cwd(), 'knowledge/public/governance/authority-role-index.json'), { encoding: 'utf8' }) as string,
    ) as { authority_roles?: Record<string, unknown> };
    const authorityDirPayloads = readPayloadsFromDir('knowledge/public/governance/authority-roles');
    expect(authorityDirPayloads.length).toBeGreaterThan(0);
    for (const payload of authorityDirPayloads) {
      expect(authoritySchema(payload)).toBe(true);
    }
    expect(
      authorityDirPayloads.map((payload) => (payload as { role?: string }).role).sort(),
    ).toEqual(Object.keys(authoritySnapshot.authority_roles || {}).sort());
  });

  it('keeps the canonical service endpoints directory aligned with the snapshot', () => {
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);

    const endpointSchema = compileSchemaFromPath(
      ajv,
      path.resolve(process.cwd(), 'knowledge/public/schemas/service-endpoints.schema.json'),
    );
    const endpointSnapshot = JSON.parse(
      safeReadFile(path.resolve(process.cwd(), 'knowledge/public/orchestration/service-endpoints.json'), { encoding: 'utf8' }) as string,
    ) as { default_pattern?: string; services?: Record<string, unknown> };
    const endpointDirPayloads = readPayloadsFromDir('knowledge/public/orchestration/service-endpoints');
    expect(endpointDirPayloads.length).toBeGreaterThan(0);
    for (const payload of endpointDirPayloads) {
      expect(endpointSchema(payload)).toBe(true);
    }
    expect(
      endpointDirPayloads.map((payload) => Object.keys((payload as { services?: Record<string, unknown> }).services || {})[0]).sort(),
    ).toEqual(Object.keys(endpointSnapshot.services || {}).sort());
  });

  it('keeps the canonical specialist catalog directory aligned with the snapshot', () => {
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);

    const specialistSchema = compileSchemaFromPath(
      ajv,
      path.resolve(process.cwd(), 'knowledge/public/schemas/specialist-catalog.schema.json'),
    );
    const specialistSnapshot = JSON.parse(
      safeReadFile(path.resolve(process.cwd(), 'knowledge/public/orchestration/specialist-catalog.json'), { encoding: 'utf8' }) as string,
    ) as { version?: string; specialists?: Record<string, unknown> };
    const specialistDirPayloads = readPayloadsFromDir('knowledge/public/orchestration/specialists');
    expect(specialistDirPayloads.length).toBeGreaterThan(0);
    for (const payload of specialistDirPayloads) {
      expect(specialistSchema(payload)).toBe(true);
    }
    expect(
      specialistDirPayloads.map((payload) => Object.keys((payload as { specialists?: Record<string, unknown> }).specialists || {})[0]).sort(),
    ).toEqual(Object.keys(specialistSnapshot.specialists || {}).sort());
  });

  it('keeps the canonical voice engine directory aligned with the snapshot', () => {
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);

    const engineSchema = compileSchemaFromPath(
      ajv,
      path.resolve(process.cwd(), 'knowledge/public/schemas/voice-engine-registry.schema.json'),
    );
    const engineSnapshot = JSON.parse(
      safeReadFile(path.resolve(process.cwd(), 'knowledge/public/governance/voice-engine-registry.json'), { encoding: 'utf8' }) as string,
    ) as { engines?: Array<{ engine_id?: string }> };
    const engineDirPayloads = readPayloadsFromDir('knowledge/public/governance/voice-engines');
    expect(engineDirPayloads.length).toBeGreaterThan(0);
    for (const payload of engineDirPayloads) {
      expect(engineSchema(payload)).toBe(true);
    }
    expect(
      engineDirPayloads.map((payload) => (payload as { engines?: Array<{ engine_id?: string }> }).engines?.[0]?.engine_id).sort(),
    ).toEqual((engineSnapshot.engines || []).map((entry: { engine_id?: string }) => entry.engine_id).sort());
  });

  it('keeps the canonical actuator manifests aligned with the runtime snapshot', () => {
    const catalog = loadActuatorManifestCatalog().map(({ manifest_path: _manifestPath, entrypoint: _entrypoint, ...entry }) => entry);
    const snapshot = JSON.parse(
      safeReadFile(path.resolve(process.cwd(), 'knowledge/public/orchestration/global_actuator_index.json'), { encoding: 'utf8' }) as string,
    ) as { actuators?: Array<Record<string, unknown>> };

    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog).toEqual(snapshot.actuators || []);
  });
});
