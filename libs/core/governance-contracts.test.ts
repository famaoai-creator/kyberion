import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeReadFile } from './secure-io.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

type GovernanceSchemaCase = {
  name: string;
  schemaPath: string;
  dataPath: string;
  invalidPayload: unknown;
};

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
    name: 'team-role-index',
    schemaPath: 'knowledge/public/schemas/team-role-index.schema.json',
    dataPath: 'knowledge/public/orchestration/team-role-index.json',
    invalidPayload: { version: '1.0.0' },
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
});
