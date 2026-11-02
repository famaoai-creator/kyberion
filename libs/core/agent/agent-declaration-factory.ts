/**
 * Declarative agent/workflow factory (PoC).
 *
 * Modeled on MSAF's AgentFactory/WorkflowFactory (agent-framework declarative
 * package): a declaration is normalized and validated up front with
 * collect-all messages (same convention as `validateAndRepairAdf`'s
 * declaration → validation step and `mission-blueprint-validation.ts`), and
 * the normalized object is constructed only when no error-severity messages
 * exist. Nothing here executes — no boot, no dispatch, no spawn.
 */

import { isRecord } from '../foundation/primitives.js';
import { KNOWLEDGE_TIERS, type KnowledgeTier } from '../foundation/knowledge-tier.js';
import { loadTeamRoleIndex } from '../mission/mission-team-index.js';
import type { MissionValidationMessage } from '../mission/mission-blueprint-validation.js';

export type DeclarationValidationMessage = MissionValidationMessage;

export interface NormalizedAgentDeclaration {
  agent_id: string;
  role: string;
  model?: string;
  instructions?: string;
  tools: string[];
  capabilities: string[];
  tier: KnowledgeTier;
}

export interface NormalizedWorkflowStep {
  step_id: string;
  kind: string;
  depends_on?: string[];
}

export interface NormalizedWorkflowDeclaration {
  steps: NormalizedWorkflowStep[];
}

export interface AgentDeclarationResult {
  agent?: NormalizedAgentDeclaration;
  messages: DeclarationValidationMessage[];
}

export interface WorkflowDeclarationResult {
  workflow?: NormalizedWorkflowDeclaration;
  messages: DeclarationValidationMessage[];
}

export interface AgentDeclarationOptions {
  /**
   * Role registry for `role` validation. Defaults to the governed team-role
   * index (knowledge/product/orchestration/team-roles) loaded best-effort;
   * inject a list to keep the check deterministic (tests) or to substitute
   * another registry.
   */
  knownRoles?: readonly string[];
}

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

let cachedDefaultRoles: readonly string[] | null | undefined;

function defaultKnownRoles(): readonly string[] | null {
  if (cachedDefaultRoles !== undefined) return cachedDefaultRoles;
  try {
    cachedDefaultRoles = Object.keys(loadTeamRoleIndex());
  } catch {
    cachedDefaultRoles = null;
  }
  return cachedDefaultRoles;
}

function error(code: string, message: string, subjectId?: string): DeclarationValidationMessage {
  return { severity: 'error', code, message, ...(subjectId ? { subject_id: subjectId } : {}) };
}

function warning(code: string, message: string, subjectId?: string): DeclarationValidationMessage {
  return { severity: 'warning', code, message, ...(subjectId ? { subject_id: subjectId } : {}) };
}

function hasErrors(messages: DeclarationValidationMessage[]): boolean {
  return messages.some((message) => message.severity === 'error');
}

function stringListField(
  input: Record<string, unknown>,
  field: string,
  code: string,
  agentId: string,
  messages: DeclarationValidationMessage[]
): string[] {
  const value = input[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    messages.push(
      error(
        code,
        `agent ${agentId || '(unknown)'} ${field} must be an array of strings`,
        agentId || undefined
      )
    );
    return [];
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

/** Normalize + validate a declarative agent definition; construct only when error-free. */
export function createAgentDeclaration(
  input: unknown,
  options?: AgentDeclarationOptions
): AgentDeclarationResult {
  const messages: DeclarationValidationMessage[] = [];
  if (!isRecord(input)) {
    messages.push(error('AGENT_DECL_NOT_OBJECT', 'agent declaration must be an object'));
    return { messages };
  }

  const agentId = String(input.agent_id ?? '').trim();
  if (!agentId) {
    messages.push(error('AGENT_DECL_ID_REQUIRED', 'agent declaration is missing agent_id'));
  } else if (!AGENT_ID_PATTERN.test(agentId)) {
    messages.push(
      error('AGENT_DECL_ID_INVALID', `agent_id '${agentId}' contains invalid characters`, agentId)
    );
  }

  const role = String(input.role ?? '').trim();
  if (!role) {
    messages.push(
      error(
        'AGENT_DECL_ROLE_REQUIRED',
        `agent ${agentId || '(unknown)'} is missing role`,
        agentId || undefined
      )
    );
  } else {
    const knownRoles = options?.knownRoles ?? defaultKnownRoles();
    if (knownRoles && !knownRoles.includes(role)) {
      messages.push(
        error(
          'AGENT_DECL_ROLE_UNKNOWN',
          `agent ${agentId || '(unknown)'} declares unknown role '${role}'`,
          agentId || undefined
        )
      );
    }
  }

  const tier = input.tier === undefined ? 'public' : String(input.tier).trim();
  if (!KNOWLEDGE_TIERS.includes(tier as KnowledgeTier)) {
    messages.push(
      error(
        'AGENT_DECL_TIER_INVALID',
        `agent ${agentId || '(unknown)'} has unknown tier '${tier}'`,
        agentId || undefined
      )
    );
  }

  let model: string | undefined;
  if (input.model !== undefined) {
    if (typeof input.model !== 'string') {
      messages.push(
        error(
          'AGENT_DECL_MODEL_INVALID',
          `agent ${agentId} model must be a string`,
          agentId || undefined
        )
      );
    } else if (input.model.trim()) {
      model = input.model.trim();
    }
  }

  let instructions: string | undefined;
  if (input.instructions !== undefined) {
    if (typeof input.instructions !== 'string') {
      messages.push(
        error(
          'AGENT_DECL_INSTRUCTIONS_INVALID',
          `agent ${agentId} instructions must be a string`,
          agentId || undefined
        )
      );
    } else if (input.instructions.trim()) {
      instructions = input.instructions;
    }
  }
  if (!instructions) {
    messages.push(
      warning(
        'AGENT_DECL_INSTRUCTIONS_MISSING',
        `agent ${agentId || '(unknown)'} has no instructions`,
        agentId || undefined
      )
    );
  }

  const tools = stringListField(input, 'tools', 'AGENT_DECL_TOOLS_INVALID', agentId, messages);
  const capabilities = stringListField(
    input,
    'capabilities',
    'AGENT_DECL_CAPABILITIES_INVALID',
    agentId,
    messages
  );

  if (hasErrors(messages)) return { messages };
  return {
    agent: {
      agent_id: agentId,
      role,
      ...(model ? { model } : {}),
      ...(instructions ? { instructions } : {}),
      tools,
      capabilities,
      tier: tier as KnowledgeTier,
    },
    messages,
  };
}

function stepDependencies(step: Record<string, unknown>): string[] {
  return Array.isArray(step.depends_on)
    ? step.depends_on.map((d) => String(d ?? '').trim()).filter(Boolean)
    : [];
}

/** DFS visiting/visited cycle detection, same pattern as mission-blueprint-validation.ts. */
function detectStepCycle(
  adjacency: Map<string, string[]>
): { start: string; path: string[] } | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string): { start: string; path: string[] } | null => {
    if (visited.has(node)) return null;
    if (visiting.has(node)) {
      const idx = stack.indexOf(node);
      return { start: node, path: [...stack.slice(idx), node] };
    }
    visiting.add(node);
    stack.push(node);
    for (const dep of adjacency.get(node) || []) {
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  };

  for (const node of adjacency.keys()) {
    const found = visit(node);
    if (found) return found;
  }
  return null;
}

/** Normalize + validate a declarative workflow definition; construct only when error-free. */
export function createWorkflowDeclaration(input: unknown): WorkflowDeclarationResult {
  const messages: DeclarationValidationMessage[] = [];
  if (!isRecord(input)) {
    messages.push(error('WORKFLOW_DECL_NOT_OBJECT', 'workflow declaration must be an object'));
    return { messages };
  }

  const rawSteps = input.steps;
  if (!Array.isArray(rawSteps)) {
    messages.push(error('WORKFLOW_STEPS_NOT_ARRAY', 'workflow steps must be an array'));
    return { messages };
  }
  if (rawSteps.length === 0) {
    messages.push(error('WORKFLOW_STEPS_EMPTY', 'workflow must declare at least one step'));
    return { messages };
  }

  const ids = new Set<string>();
  const adjacency = new Map<string, string[]>();
  const idList: string[] = [];
  const steps: NormalizedWorkflowStep[] = [];

  rawSteps.forEach((entry, index) => {
    if (!isRecord(entry)) {
      messages.push(
        error('WORKFLOW_STEP_NOT_OBJECT', `step ${index + 1} is not an object`, `index:${index}`)
      );
      return;
    }
    const stepId = String(entry.step_id ?? '').trim();
    if (!stepId) {
      messages.push(
        error('WORKFLOW_STEP_ID_REQUIRED', `step ${index + 1} is missing step_id`, `index:${index}`)
      );
      return;
    }
    const kind = String(entry.kind ?? '').trim();
    if (!kind) {
      messages.push(error('WORKFLOW_STEP_KIND_REQUIRED', `step ${stepId} is missing kind`, stepId));
    }
    if (
      entry.depends_on !== undefined &&
      (!Array.isArray(entry.depends_on) || entry.depends_on.some((dep) => typeof dep !== 'string'))
    ) {
      messages.push(
        error(
          'WORKFLOW_STEP_DEPENDENCIES_INVALID',
          `step ${stepId} depends_on must be an array of step ids`,
          stepId
        )
      );
    }
    if (ids.has(stepId)) {
      messages.push(error('WORKFLOW_STEP_ID_DUPLICATE', `duplicate step_id ${stepId}`, stepId));
      return;
    }
    ids.add(stepId);
    idList.push(stepId);
    const dependsOn = stepDependencies(entry);
    adjacency.set(stepId, dependsOn);
    steps.push({ step_id: stepId, kind, ...(dependsOn.length ? { depends_on: dependsOn } : {}) });
  });

  for (const stepId of idList) {
    for (const dep of adjacency.get(stepId) || []) {
      if (!ids.has(dep)) {
        messages.push(
          error(
            'WORKFLOW_DEPENDENCY_MISSING',
            `step ${stepId} depends on unknown step ${dep}`,
            stepId
          )
        );
      }
    }
  }

  const knownOnly = new Map<string, string[]>();
  for (const [stepId, deps] of adjacency) {
    knownOnly.set(
      stepId,
      deps.filter((dep) => ids.has(dep))
    );
  }
  const cycle = detectStepCycle(knownOnly);
  if (cycle) {
    messages.push(
      error(
        'STEP_DEPENDENCY_CYCLE',
        `dependency cycle detected: ${cycle.path.join(' -> ')}`,
        cycle.start
      )
    );
  }

  if (hasErrors(messages)) return { messages };
  return { workflow: { steps }, messages };
}
