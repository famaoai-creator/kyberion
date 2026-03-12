/**
 * Fixture Generator - Test data generation utilities
 *
 * Provides generators for creating test data including ADF contracts,
 * mission contracts, and schema-based test data.
 */

import type { MissionContract } from '@agent/core/src/types/mission-contract';
import type { SkillInput, TierLevel } from '@agent/core/types';

/**
 * Options for generating ADF (Agentic Data Format) test data
 */
export interface ADFOptions {
  skill?: string;
  action?: string;
  params?: Record<string, unknown>;
  tier?: TierLevel;
}

/**
 * Options for generating Mission Contract test data
 */
export interface MissionOptions {
  mission_id?: string;
  skill?: string;
  action?: string;
  role?: string;
  risk_level?: number;
  require_sudo?: boolean;
}

/**
 * Generates a test ADF (Agentic Data Format) object
 *
 * @param options - Configuration options for the ADF
 * @returns SkillInput object representing an ADF contract
 */
export function generateADF(options?: ADFOptions): SkillInput {
  const defaults: SkillInput = {
    skill: 'test-skill',
    action: 'execute',
    params: {
      target: 'test-target',
      value: 'test-value',
    },
    context: {
      knowledge_tier: 'public',
      caller: 'test-generator',
      session_id: `session-${Date.now()}`,
    },
  };

  if (options) {
    if (options.skill) defaults.skill = options.skill;
    if (options.action) defaults.action = options.action;
    if (options.params) defaults.params = { ...defaults.params, ...options.params };
    if (options.tier && defaults.context) defaults.context.knowledge_tier = options.tier;
  }

  return defaults;
}

/**
 * Generates a test Mission Contract
 *
 * @param options - Configuration options for the mission contract
 * @returns MissionContract object
 */
export function generateMissionContract(options?: MissionOptions): MissionContract {
  const missionId = options?.mission_id || `MISSION-${Date.now()}`;

  const contract: MissionContract = {
    mission_id: missionId,
    skill: options?.skill || 'test-skill',
    action: options?.action || 'execute',
    static_params: {
      target: 'test-target',
      mode: 'test',
    },
  };

  if (options?.role) {
    contract.role = options.role;
  }

  if (options?.risk_level !== undefined || options?.require_sudo !== undefined) {
    contract.safety_gate = {
      risk_level: options?.risk_level ?? 1,
      require_sudo: options?.require_sudo ?? false,
      approved_by_sovereign: false,
    };
  }

  return contract;
}

/**
 * Generates test data based on a simple schema
 *
 * @param schema - Schema definition for the test data
 * @returns Generated test data matching the schema
 */
export function generateTestData<T>(schema: Schema): T {
  const result: any = {};

  for (const [key, type] of Object.entries(schema)) {
    result[key] = generateValueForType(type);
  }

  return result as T;
}

/**
 * Schema definition for test data generation
 */
export type Schema = Record<string, SchemaType>;

/**
 * Supported schema types
 */
export type SchemaType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'date'
  | { type: 'array'; items: SchemaType }
  | { type: 'object'; properties: Schema };

/**
 * Generates a value for a given schema type
 */
function generateValueForType(type: SchemaType): unknown {
  if (typeof type === 'string') {
    switch (type) {
      case 'string':
        return `test-string-${Math.random().toString(36).substring(7)}`;
      case 'number':
        return Math.floor(Math.random() * 1000);
      case 'boolean':
        return Math.random() > 0.5;
      case 'array':
        return [];
      case 'object':
        return {};
      case 'date':
        return new Date();
      default:
        return null;
    }
  }

  if (typeof type === 'object') {
    if (type.type === 'array') {
      const itemType = type.items || 'string';
      return [generateValueForType(itemType), generateValueForType(itemType)];
    }
    if (type.type === 'object' && type.properties) {
      return generateTestData(type.properties);
    }
  }

  return null;
}

/**
 * Generates a mission state object for testing
 */
export interface MissionStateOptions {
  mission_id?: string;
  tier?: 'personal' | 'confidential' | 'public';
  status?:
    | 'planned'
    | 'active'
    | 'validating'
    | 'distilling'
    | 'completed'
    | 'paused'
    | 'failed'
    | 'archived';
  execution_mode?: 'local' | 'delegated';
}

export function generateMissionState(options?: MissionStateOptions) {
  return {
    mission_id: options?.mission_id || `MISSION-${Date.now()}`,
    tier: options?.tier || 'public',
    status: options?.status || 'planned',
    execution_mode: options?.execution_mode || 'local',
    priority: 5,
    assigned_persona: 'test-persona',
    confidence_score: 0.8,
    git: {
      branch: 'main',
      start_commit: 'abc123',
      latest_commit: 'def456',
      checkpoints: [],
    },
    history: [
      {
        ts: new Date().toISOString(),
        event: 'created',
        note: 'Test mission created',
      },
    ],
  };
}
