import {
  ContractCheck,
  readGovernanceJson,
  readServiceEndpointPayloads,
  readServicePresetPayloads,
} from './check_contract_schemas_shared.js';

export function createServiceChecks(): ContractCheck[] {
  return [
    {
      id: 'service-endpoints',
      schemaPath: 'knowledge/product/schemas/service-endpoints.schema.json',
      validPayloads: [
        {
          default_pattern: 'https://api.{service_id}.com/v1',
          services: {
            moltbook: {
              base_url: 'https://www.moltbook.com/api/v1',
            },
            slack: {
              base_url: 'https://slack.com/api',
              preset_path: 'knowledge/product/orchestration/service-presets/slack.json',
            },
            github: {
              base_url: 'https://api.github.com',
              preset_path: 'knowledge/product/orchestration/service-presets/github.json',
            },
          },
        },
        ...readServiceEndpointPayloads(),
      ],
      invalidPayloads: [
        {
          default_pattern: 'https://api.{service_id}.com/v1',
          services: {
            broken: {},
          },
        },
      ],
    },
    {
      id: 'service-presets',
      schemaPath: 'knowledge/product/schemas/service-presets.schema.json',
      validPayloads: [...readServicePresetPayloads()],
      invalidPayloads: [
        {
          service_id: 'slack',
        },
      ],
    },
    {
      id: 'service-bootstrap-catalog',
      schemaPath: 'knowledge/product/schemas/service-bootstrap-catalog.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/service-bootstrap-catalog.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          entries: [
            {
              id: 'broken',
              service_id: 'slack',
            },
          ],
        },
      ],
    },
    {
      id: 'service-onboarding-catalog',
      schemaPath: 'knowledge/product/schemas/service-onboarding-catalog.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/service-onboarding-catalog.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          services: [{ service_id: 'comfyui' }],
        },
      ],
    },
    {
      id: 'service-runtime-policy',
      schemaPath: 'knowledge/product/schemas/service-runtime-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/service-runtime-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          managed_roots: { service_runtime_root: 'active/shared/runtime' },
        },
      ],
    },
    {
      id: 'service-runtime-registry',
      schemaPath: 'knowledge/product/schemas/service-runtime-registry.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/service-runtime-registry.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          default_service_id: 'comfyui',
          services: [{ service_id: 'comfyui' }],
        },
      ],
    },
  ];
}
