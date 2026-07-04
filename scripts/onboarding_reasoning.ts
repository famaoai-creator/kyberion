import { loadEnvironmentManifest, probeManifest } from '@agent/core';

import '@agent/core/environment-capability-probes';

export type OnboardingReasoningMode =
  | 'real_backend_detected'
  | 'stub_explicit'
  | 'stub_acknowledged'
  | 'missing';

export interface OnboardingReasoningState {
  mode: OnboardingReasoningMode;
  backend_hint: string;
  available: boolean;
  reason?: string;
  checked_at: string;
}

export async function evaluateReasoningBackend(
  now = new Date()
): Promise<OnboardingReasoningState> {
  const explicitBackend = process.env.KYBERION_REASONING_BACKEND?.trim();
  if (explicitBackend === 'stub') {
    return {
      mode: 'stub_explicit',
      backend_hint: 'stub',
      available: false,
      reason: 'KYBERION_REASONING_BACKEND=stub is explicitly selected for offline placeholders.',
      checked_at: now.toISOString(),
    };
  }

  const manifest = loadEnvironmentManifest('reasoning-backend');
  const statuses = await probeManifest(manifest);
  const reasoningStatus =
    statuses.find((status) => status.capability_id === 'reasoning-backend.any-real') ??
    statuses.find((status) => !status.satisfied);

  if (reasoningStatus?.satisfied) {
    return {
      mode: 'real_backend_detected',
      backend_hint: explicitBackend || 'auto',
      available: true,
      checked_at: now.toISOString(),
    };
  }

  return {
    mode: 'missing',
    backend_hint: explicitBackend || 'unconfigured',
    available: false,
    reason:
      reasoningStatus?.reason ??
      'No real reasoning backend was detected. Run `pnpm reasoning:setup`.',
    checked_at: now.toISOString(),
  };
}

export function markReasoningStubAcknowledged(
  state: OnboardingReasoningState
): OnboardingReasoningState {
  return {
    ...state,
    mode: 'stub_acknowledged',
    reason:
      state.reason ??
      'The operator acknowledged that onboarding can continue without a real reasoning backend.',
  };
}

export function formatReasoningSummary(state?: OnboardingReasoningState): string[] {
  if (!state) {
    return ['- Status: not checked'];
  }
  return [
    `- Status: ${state.mode}`,
    `- Backend hint: ${state.backend_hint}`,
    `- Real backend available: ${state.available ? 'yes' : 'no'}`,
    ...(state.reason ? [`- Reason: ${state.reason}`] : []),
    `- Checked at: ${state.checked_at}`,
  ];
}
