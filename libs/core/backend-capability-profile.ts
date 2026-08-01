/**
 * Backend capability profiles (QM-06, ported from qm's HarnessAdapterProfile).
 *
 * Every reasoning backend mode DECLARES its transport and capability set here
 * so routing can select by declared capability instead of tribal knowledge,
 * and a conformance test pins the declarations (completeness is enforced at
 * the type level: the Record covers the whole mode union).
 *
 * Honest scope: these are declarations plus spot conformance checks. A full
 * live conformance matrix (exercising each CLI for abort/structured-output
 * support) is a follow-up recorded in the QM adoption plan — do not treat a
 * declared capability as proven until that lands.
 */

import type { ReasoningBackendMode } from './reasoning-backend-policy.js';

export type BackendTransport = 'cli' | 'sdk' | 'api' | 'local-server' | 'in-process';

export type BackendUtilityFit = 'judge' | 'classify' | 'summarize' | 'divergent';

export interface BackendCapabilityProfile {
  mode: ReasoningBackendMode;
  transport: BackendTransport;
  capabilities: {
    structured_output: boolean;
    session_continuity: boolean;
    abort: boolean;
    images: boolean;
  };
  utility_fit: BackendUtilityFit[];
}

const cli = (
  mode: ReasoningBackendMode,
  overrides: Partial<BackendCapabilityProfile['capabilities']> = {},
  utilityFit: BackendUtilityFit[] = ['judge', 'classify', 'summarize', 'divergent']
): BackendCapabilityProfile => ({
  mode,
  transport: 'cli',
  capabilities: {
    structured_output: true,
    session_continuity: true,
    abort: true,
    images: false,
    ...overrides,
  },
  utility_fit: utilityFit,
});

const api = (
  mode: ReasoningBackendMode,
  overrides: Partial<BackendCapabilityProfile['capabilities']> = {},
  utilityFit: BackendUtilityFit[] = ['judge', 'classify', 'summarize', 'divergent']
): BackendCapabilityProfile => ({
  mode,
  transport: 'api',
  capabilities: {
    structured_output: true,
    session_continuity: false,
    abort: true,
    images: false,
    ...overrides,
  },
  utility_fit: utilityFit,
});

const localServer = (mode: ReasoningBackendMode): BackendCapabilityProfile => ({
  mode,
  transport: 'local-server',
  capabilities: {
    structured_output: false,
    session_continuity: false,
    abort: true,
    images: false,
  },
  utility_fit: ['classify', 'summarize'],
});

export const BACKEND_CAPABILITY_PROFILES: Record<ReasoningBackendMode, BackendCapabilityProfile> = {
  // ShellClaudeCliBackend spawns a fresh CLI per call — no session continuity.
  'claude-cli': cli('claude-cli', { session_continuity: false }),
  'codex-cli': cli('codex-cli'),
  'claude-agent': {
    mode: 'claude-agent',
    transport: 'sdk',
    capabilities: {
      structured_output: true,
      session_continuity: true,
      abort: true,
      images: true,
    },
    utility_fit: ['judge', 'classify', 'summarize', 'divergent'],
  },
  anthropic: api('anthropic', { images: true }),
  'gemini-cli': cli('gemini-cli'),
  'gemini-api': api('gemini-api', { images: true }),
  'agy-cli': cli('agy-cli'),
  'grok-cli': cli('grok-cli'),
  // CopilotAcpReasoningBackend holds a persistent ACP mediator session.
  copilot: cli('copilot', { session_continuity: true }),
  local: localServer('local'),
  ollama: localServer('ollama'),
  vllm: localServer('vllm'),
  lmstudio: localServer('lmstudio'),
  llamacpp: localServer('llamacpp'),
  mlx: localServer('mlx'),
  localai: localServer('localai'),
  nemotron: localServer('nemotron'),
  'nemotron-api': api('nemotron-api'),
  openrouter: api('openrouter'),
  stub: {
    mode: 'stub',
    transport: 'in-process',
    capabilities: {
      structured_output: true,
      session_continuity: false,
      abort: true,
      images: false,
    },
    // The stub is deterministic — it can exercise plumbing but must never
    // be treated as capable of real judgment or divergent thinking
    // (AGENTS.md: wisdom:* ops need a non-stub backend).
    utility_fit: [],
  },
};

export function backendCapabilityProfile(mode: ReasoningBackendMode): BackendCapabilityProfile {
  return BACKEND_CAPABILITY_PROFILES[mode];
}

export function modesWithUtilityFit(fit: BackendUtilityFit): ReasoningBackendMode[] {
  return (Object.values(BACKEND_CAPABILITY_PROFILES) as BackendCapabilityProfile[])
    .filter((profile) => profile.utility_fit.includes(fit))
    .map((profile) => profile.mode);
}
