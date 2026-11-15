import { createLogger } from '../logger.js';
import { isLocalReasoningBackend } from '../reasoning/reasoning-egress-scope.js';
import { loadReasoningBackendPolicy } from '../reasoning/reasoning-backend-policy.js';
import { sendOpsAlert } from '../daemon/ops-alert.js';
import type { ReasoningBackend } from '../reasoning/reasoning-backend-contracts.js';
import type { DotCharter } from './dot-charter.js';

const logger = createLogger('dot-runtime');

/**
 * Local-only provider modes, in preference order. Derived from the governed
 * `allowed_modes` list — every mode whose capability profile declares
 * `data_egress 'local-only'` — so a newly registered local provider is tried
 * without a code change. The literal tail is the fallback when the policy
 * cannot be loaded.
 */
const LOCAL_ONLY_WAKE_BACKEND_FALLBACK = [
  'ollama',
  'mlx',
  'lmstudio',
  'localai',
  'llamacpp',
  'vllm',
  'local',
] as const;

function localOnlyWakeBackendModes(): readonly string[] {
  try {
    const modes = loadReasoningBackendPolicy().allowed_modes.filter((mode) =>
      isLocalReasoningBackend(mode)
    );
    if (modes.length > 0) return modes;
  } catch {
    // Policy unavailable — fall back to the known-local set below.
  }
  return LOCAL_ONLY_WAKE_BACKEND_FALLBACK;
}

/**
 * Build a local-only backend for a confidential wake, or null when no local
 * provider can be instantiated (not installed, no endpoint configured).
 */
export async function buildLocalOnlyWakeBackend(
  charter: DotCharter
): Promise<ReasoningBackend | null> {
  const { buildReasoningBackendForMode } = await import('../reasoning/reasoning-bootstrap.js');
  const modes = localOnlyWakeBackendModes();
  for (const mode of modes) {
    try {
      const built = buildReasoningBackendForMode(mode);
      if (built?.backend && isLocalReasoningBackend(built.backend.name)) return built.backend;
    } catch {
      // Mode unavailable — try the next local provider.
    }
  }
  logger.debug(
    `no local-only reasoning backend available for ${charter.dot_id} — tried ${modes.join(', ')}`
  );
  return null;
}

/** One deduped alert per dot when a confidential wake has no usable backend. */
export function alertDotWakeLocalBackendUnavailable(
  charter: DotCharter,
  activeBackend: string
): void {
  try {
    sendOpsAlert({
      severity: 'warning',
      title: `No local-only reasoning backend for ${charter.dot_id}`,
      context: {
        dot_id: charter.dot_id,
        active_backend: activeBackend,
        tier: charter.scope.tier,
      },
      recommendation: `Wakes for ${charter.dot_id} (tier '${charter.scope.tier}', training_use 'local_only') cannot use external backend '${activeBackend}'. Install a local provider (ollama/mlx/lmstudio) or attest a no-training provider: 'pnpm onboarding llm attest --tenant ${charter.scope.tenant_slug ?? '<slug>'} --provider <id> --training-use none --request-approval'.`,
      dedupe_key: `dot-wake-local-backend:${charter.dot_id}`,
      category: 'dot',
    });
  } catch {
    // Observability only — the classified failure below is the durable record.
  }
}
