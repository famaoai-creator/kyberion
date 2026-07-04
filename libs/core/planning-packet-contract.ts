import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import type { PlanningPacket } from './channel-surface-types.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const PLANNING_PACKET_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/planning-packet.schema.json'
);

let planningPacketValidateFn: ValidateFunction | null = null;

export interface PlanningPacketValidationResult {
  valid: boolean;
  errors: string[];
  value?: PlanningPacket;
}

export interface ExtractPlanningPacketBlocksResult {
  text: string;
  planningPackets: PlanningPacket[];
  planningPacketErrors: string[];
}

function ensurePlanningPacketValidator(): ValidateFunction {
  if (planningPacketValidateFn) return planningPacketValidateFn;
  planningPacketValidateFn = compileSchemaFromPath(ajv, PLANNING_PACKET_SCHEMA_PATH);
  return planningPacketValidateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

function validateParsedPlanningPacket(value: unknown): PlanningPacketValidationResult {
  const validate = ensurePlanningPacketValidator();
  const valid = validate(value);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : errorsFrom(validate),
    value: valid ? (value as PlanningPacket) : undefined,
  };
}

export function validatePlanningPacket(value: unknown): PlanningPacketValidationResult {
  return validateParsedPlanningPacket(value);
}

export function extractPlanningPacketBlocks(raw: string): ExtractPlanningPacketBlocksResult {
  const planningPackets: PlanningPacket[] = [];
  const planningPacketErrors: string[] = [];
  let text = raw;

  text = text.replace(/```(?:\s*)planning_packet\s*\n([\s\S]*?)```/gi, (_match, json) => {
    const trimmed = String(json).trim();
    if (!trimmed) {
      planningPacketErrors.push('planning_packet block was empty');
      return '';
    }

    try {
      const parsed = JSON.parse(trimmed);
      const validation = validateParsedPlanningPacket(parsed);
      if (validation.valid && validation.value) {
        planningPackets.push(validation.value);
      } else {
        planningPacketErrors.push(
          `planning_packet validation failed: ${validation.errors.join('; ')}`
        );
      }
    } catch (error: any) {
      planningPacketErrors.push(
        `planning_packet JSON parse failed: ${error?.message ?? String(error)}`
      );
    }
    return '';
  });

  return { text, planningPackets, planningPacketErrors };
}
