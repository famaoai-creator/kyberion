import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { safeJsonParse } from './validators.js';

const DEFAULT_POLICY_PATH = pathResolver.knowledge('public/governance/tool-actuator-routing-policy.json');

export interface ToolActuatorRouteRule {
  tool_name: string;
  execution_mode: 'deterministic_pipeline' | 'llm_reasoning' | 'mission_command' | 'actuator_direct';
  intent_ids?: string[];
  preferred_actuators: string[];
  fallback_pipeline_id?: string;
  notes?: string;
}

export interface ToolActuatorRoutingPolicy {
  version: string;
  defaults: {
    fallback_actuator: string;
    require_approval_on_mismatch: boolean;
  };
  tool_routes: ToolActuatorRouteRule[];
}

export interface ResolvedToolActuatorRoute {
  tool_name: string;
  intent_id?: string;
  execution_mode: ToolActuatorRouteRule['execution_mode'];
  preferred_actuators: string[];
  fallback_pipeline_id?: string;
  require_approval_on_mismatch: boolean;
  source: 'policy_match' | 'fallback';
}

const FALLBACK_POLICY: ToolActuatorRoutingPolicy = {
  version: 'fallback',
  defaults: {
    fallback_actuator: 'orchestrator-actuator',
    require_approval_on_mismatch: true,
  },
  tool_routes: [],
};

let cachedPolicyPath: string | null = null;
let cachedPolicy: ToolActuatorRoutingPolicy | null = null;

function getPolicyPath(): string {
  return process.env.KYBERION_TOOL_ACTUATOR_ROUTING_POLICY_PATH?.trim() || DEFAULT_POLICY_PATH;
}

export function resetToolActuatorRoutingPolicyCache(): void {
  cachedPolicyPath = null;
  cachedPolicy = null;
}

export function getToolActuatorRoutingPolicy(): ToolActuatorRoutingPolicy {
  const policyPath = getPolicyPath();
  if (cachedPolicyPath === policyPath && cachedPolicy) return cachedPolicy;

  if (!safeExistsSync(policyPath)) {
    cachedPolicyPath = policyPath;
    cachedPolicy = FALLBACK_POLICY;
    return cachedPolicy;
  }

  const raw = safeReadFile(policyPath, { encoding: 'utf8' }) as string;
  const parsed = safeJsonParse<ToolActuatorRoutingPolicy>(raw, 'tool actuator routing policy');
  cachedPolicyPath = policyPath;
  cachedPolicy = parsed;
  return parsed;
}

export function resolveToolActuatorRoute(input: {
  toolName: string;
  intentId?: string;
}): ResolvedToolActuatorRoute {
  const policy = getToolActuatorRoutingPolicy();
  const toolName = input.toolName.trim();
  const intentId = input.intentId?.trim();

  const byTool = policy.tool_routes.filter((route) => route.tool_name === toolName);
  const exact = intentId
    ? byTool.find((route) => (route.intent_ids || []).includes(intentId))
    : undefined;
  const picked = exact || byTool[0];

  if (picked) {
    return {
      tool_name: toolName,
      ...(intentId ? { intent_id: intentId } : {}),
      execution_mode: picked.execution_mode,
      preferred_actuators: picked.preferred_actuators,
      ...(picked.fallback_pipeline_id ? { fallback_pipeline_id: picked.fallback_pipeline_id } : {}),
      require_approval_on_mismatch: policy.defaults.require_approval_on_mismatch,
      source: 'policy_match',
    };
  }

  return {
    tool_name: toolName,
    ...(intentId ? { intent_id: intentId } : {}),
    execution_mode: 'llm_reasoning',
    preferred_actuators: [policy.defaults.fallback_actuator],
    require_approval_on_mismatch: policy.defaults.require_approval_on_mismatch,
    source: 'fallback',
  };
}
