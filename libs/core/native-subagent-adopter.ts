import type { ReasoningCallOptions } from './reasoning-backend.js';

/**
 * Provider-neutral adoption point for a host/provider-native subagent
 * surface. The adopter owns protocol details, session reuse, permissions,
 * cancellation, and provider metadata; dispatchers only see this contract.
 */
export interface NativeSubagentAdopter {
  readonly id: string;
  dispatch(instruction: string, context?: string, options?: ReasoningCallOptions): Promise<string>;
  getInfo?(): Record<string, unknown> | null;
}
