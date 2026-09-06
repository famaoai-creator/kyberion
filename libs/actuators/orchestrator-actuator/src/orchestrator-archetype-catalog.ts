import { isRecord } from '@agent/core/foundation';

export interface ActuatorRequestArchetype {
  id: string;
  trigger_keywords: string[];
  summary_template: string;
  normalized_scope: string[];
  target_actuators: string[];
  deliverables: string[];
  required_inputs: string[];
}

export interface ActuatorRequestArchetypeCatalog {
  default_archetype: string;
  archetypes: ActuatorRequestArchetype[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

export function parseActuatorRequestArchetypeCatalog(
  value: unknown
): ActuatorRequestArchetypeCatalog | null {
  if (!isRecord(value) || !isNonEmptyString(value.default_archetype)) return null;
  if (!Array.isArray(value.archetypes) || value.archetypes.length === 0) return null;

  const archetypes: ActuatorRequestArchetype[] = [];
  for (const candidate of value.archetypes) {
    if (
      !isRecord(candidate) ||
      !isNonEmptyString(candidate.id) ||
      !isNonEmptyStringArray(candidate.trigger_keywords) ||
      !isNonEmptyString(candidate.summary_template) ||
      !isNonEmptyStringArray(candidate.normalized_scope) ||
      !isNonEmptyStringArray(candidate.target_actuators) ||
      !isNonEmptyStringArray(candidate.deliverables) ||
      !isNonEmptyStringArray(candidate.required_inputs)
    ) {
      return null;
    }
    archetypes.push({
      id: candidate.id,
      trigger_keywords: [...candidate.trigger_keywords],
      summary_template: candidate.summary_template,
      normalized_scope: [...candidate.normalized_scope],
      target_actuators: [...candidate.target_actuators],
      deliverables: [...candidate.deliverables],
      required_inputs: [...candidate.required_inputs],
    });
  }

  if (!archetypes.some((archetype) => archetype.id === value.default_archetype)) return null;
  return {
    default_archetype: value.default_archetype,
    archetypes,
  };
}
