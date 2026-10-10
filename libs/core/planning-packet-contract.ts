import { PlanningPacketSchema, formatZodIssues } from './structured-output-contracts.js';
import type { PlanningPacket } from './surface/channel-surface-types.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { replaceFencedBlocks } from './foundation/text.js';

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

function validateParsedPlanningPacket(value: unknown): PlanningPacketValidationResult {
  const result = PlanningPacketSchema.safeParse(value);
  return {
    valid: result.success,
    errors: result.success ? [] : formatZodIssues(result.error),
    value: result.success ? result.data : undefined,
  };
}

export function validatePlanningPacket(value: unknown): PlanningPacketValidationResult {
  return validateParsedPlanningPacket(value);
}

export function extractPlanningPacketBlocks(raw: string): ExtractPlanningPacketBlocksResult {
  const planningPackets: PlanningPacket[] = [];
  const planningPacketErrors: string[] = [];
  let text = raw;

  text = replaceFencedBlocks(text, (lang, content, block) => {
    if (lang.toLowerCase() !== 'planning_packet') return block;
    const json = content;
    const trimmed = String(json).trim();
    if (!trimmed) {
      planningPacketErrors.push('planning_packet block was empty');
      return '';
    }

    try {
      const parsed = parseSafeJsonInput(trimmed, 'planning_packet block');
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
