import { resolveRuntimeDefaultModelId, type ProviderConfigRuntimeRole } from './provider-config.js';

export type RuntimeModelRole = ProviderConfigRuntimeRole;

const RUNTIME_MODEL_ENV_OVERRIDES: Readonly<Record<RuntimeModelRole, readonly string[]>> = {
  'anthropic-default': [
    'KYBERION_ANTHROPIC_MODEL',
    'KYBERION_CLAUDE_MODEL',
    'KYBERION_REASONING_MODEL',
  ],
  'anthropic-fast': ['KYBERION_ANTHROPIC_FAST_MODEL', 'KYBERION_CLAUDE_FAST_MODEL'],
  'gemini-default': ['KYBERION_GEMINI_MODEL'],
  'gemini-fast': ['KYBERION_GEMINI_FAST_MODEL'],
  'openai-vision': ['KYBERION_OPENAI_VISION_MODEL', 'KYBERION_OPENAI_MODEL'],
  'codex-default': ['KYBERION_CODEX_MODEL'],
  'copilot-default': ['KYBERION_COPILOT_MODEL'],
};

export function resolveRuntimeModelId(
  role: RuntimeModelRole,
  env: NodeJS.ProcessEnv = process.env
): string {
  for (const key of RUNTIME_MODEL_ENV_OVERRIDES[role]) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return resolveRuntimeDefaultModelId(role);
}
