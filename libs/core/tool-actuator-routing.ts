import { pathResolver } from './path-resolver.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { assertSafeRepositoryPath } from './secure-io.js';

const DEFAULT_POLICY_PATH = pathResolver.knowledge(
  'product/governance/tool-actuator-routing-policy.json'
);

export interface ToolActuatorRouteRule {
  tool_name: string;
  execution_mode:
    'deterministic_pipeline' | 'llm_reasoning' | 'mission_command' | 'actuator_direct';
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

const toolActuatorRoutingCatalog = defineCatalog<ToolActuatorRoutingPolicy>({
  id: 'tool-actuator-routing-policy',
  path: getPolicyPath,
  schema: pathResolver.knowledge('product/schemas/tool-actuator-routing-policy.schema.json'),
});

let cachedPolicyPath: string | null = null;
let cachedPolicy: ToolActuatorRoutingPolicy | null = null;

function getPolicyPath(): string {
  return assertSafeRepositoryPath(
    getRegisteredEnvText('KYBERION_TOOL_ACTUATOR_ROUTING_POLICY_PATH')?.trim() ||
      DEFAULT_POLICY_PATH,
    { allowMissingLeaf: true }
  );
}

export function getToolActuatorRoutingPolicy(): ToolActuatorRoutingPolicy {
  const policyPath = toolActuatorRoutingCatalog.path();
  if (cachedPolicyPath === policyPath && cachedPolicy) return cachedPolicy;
  const parsed = toolActuatorRoutingCatalog.load();
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
