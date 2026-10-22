import { getRegisteredEnvText } from '../foundation/env.js';

/** Non-secret policy selectors only. Temporary elevation and proof keys are
 * never serialized into journals or replayed by an approval callback. */
export const PIPELINE_RESUME_POLICY_ENV_KEYS = [
  'KYBERION_ALLOW_FILE_SECRETS',
  'KYBERION_ALLOW_LOCAL_NETWORK',
  'KYBERION_ALLOW_STUB_FALLBACK',
  'KYBERION_ALLOW_TEST_NOTIFICATIONS',
  'KYBERION_ALLOW_UNAUTH_REMOTE',
  'KYBERION_ALLOW_UNSAFE_CLI',
  'KYBERION_ALLOW_UNSAFE_JS',
  'KYBERION_ALLOW_UNSAFE_SHELL',
  'KYBERION_APPROVAL_ASSURANCE',
  'KYBERION_AUTHZ_POLICY_PATH',
  'KYBERION_AUTONOMOUS_OPS_POLICY_PATH',
  'KYBERION_CODEX_APPROVAL',
  'KYBERION_EGRESS_POLICY',
  'KYBERION_EGRESS_POLICY_PATH',
  'KYBERION_KNOWLEDGE_FEEDBACK_POLICY_PATH',
  'KYBERION_OIDC_ALLOW_HS256',
  'KYBERION_OPENROUTER_COST_POLICY',
  'KYBERION_PROVIDER_EGRESS_POLICY_PATH',
  'KYBERION_PROVIDER_ENV_ALLOWLIST',
  'KYBERION_REASONING_ALLOW_SHELL_TOOL',
  'KYBERION_RESTRICTED_ACTIONS_POLICY',
  'KYBERION_SERVICE_RUNTIME_POLICY_PATH',
  'KYBERION_SHARE_GRANTS_PATH',
  'KYBERION_SHELL_COMMAND_POLICY_PATH',
  'KYBERION_SURFACE_ALLOWLISTS',
  'KYBERION_TENANT_EGRESS_POLICY_PATH',
  'KYBERION_TOOL_ACTUATOR_ROUTING_POLICY_PATH',
  'KYBERION_TOOL_RUNTIME_POLICY_PATH',
  'KYBERION_TRUST_PROXY',
  'KYBERION_VIDEO_RENDER_RUNTIME_POLICY_PATH',
  'KYBERION_VOICE_RUNTIME_POLICY_PATH',
  'KYBERION_VOICE_SAMPLE_INGESTION_POLICY_PATH',
] as const;

const known = new Set<string>(PIPELINE_RESUME_POLICY_ENV_KEYS);
const special = new Set([
  'KYBERION_TASK_GRANTS_PATH',
  'KYBERION_SUDO',
  'KYBERION_SUDO_SCOPE',
  'KYBERION_SUDO_KEY',
]);
const controlKey = (key: string) =>
  /^KYBERION_.*(?:POLICY|ALLOW|UNSAFE|TRUST|GRANTS|APPROVAL|PERMISSION)/u.test(key);

export function capturePipelineResumePolicyEnvironment(): {
  policy_env: Record<string, string>;
  unsupported_policy_env: string[];
} {
  return {
    policy_env: Object.fromEntries(
      PIPELINE_RESUME_POLICY_ENV_KEYS.map((key) => [key, getRegisteredEnvText(key) ?? ''])
    ),
    unsupported_policy_env: Object.keys(process.env)
      .filter(
        (key) =>
          controlKey(key) && !known.has(key) && !special.has(key) && Boolean(process.env[key])
      )
      .sort(),
  };
}

export function restorePipelineResumePolicyEnvironment(
  source: Record<string, string>,
  base: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) if (controlKey(key)) delete env[key];
  for (const key of PIPELINE_RESUME_POLICY_ENV_KEYS) env[key] = source[key] ?? '';
  return env;
}
