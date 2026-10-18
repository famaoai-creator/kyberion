import type {
  DiscussionConfig,
  DiscussionRoomState,
} from '@agent/core/discussion/discussion-types';

export type DiscussionRunFormat = 'brief' | 'panel' | 'dialogue';
export type DiscussionEngineChoice = 'scripted' | 'claude' | 'codex';

/** One browser submission, with visible finite limits. No automatic provider selection. */
export function discussionRunConfig(format: DiscussionRunFormat, choice: DiscussionEngineChoice) {
  return {
    mode: format === 'dialogue' ? ('dialogue' as const) : ('panel' as const),
    single_pass: format === 'brief',
    max_rounds: 1,
    max_provider_calls:
      choice === 'scripted' ? 0 : format === 'brief' ? 1 : format === 'panel' ? 9 : 32,
    provider_timeout_ms: 60_000,
    speaker: choice === 'scripted' ? ('scripted' as const) : ('reasoning' as const),
    ...(choice !== 'scripted' ? { provider: choice } : {}),
  };
}

/** Reject ambiguous real execution before creating or starting a room. */
export function readDiscussionExecutionConfig(
  body: Record<string, unknown>
): Partial<DiscussionConfig> {
  const speaker = body.speaker ?? 'scripted';
  if (speaker !== 'scripted' && speaker !== 'reasoning' && speaker !== 'auto') {
    throw new Error('Invalid discussion speaker.');
  }
  const provider = body.provider;
  if (provider !== undefined && provider !== 'claude' && provider !== 'codex') {
    throw new Error('Choose an explicitly supported discussion provider.');
  }
  if (speaker !== 'scripted' && !provider) {
    throw new Error(
      'Real discussion execution requires an explicit provider; no automatic fallback is used.'
    );
  }
  if (speaker !== 'scripted' && body.max_provider_calls === 0) {
    throw new Error(
      'A zero provider-call budget cannot authorize generation. Choose scripted mode or an explicit positive budget.'
    );
  }
  const singlePass = body.single_pass === true;
  if (body.single_pass !== undefined && typeof body.single_pass !== 'boolean') {
    throw new Error('single_pass must be a boolean.');
  }
  if (singlePass && body.mode === 'dialogue') {
    throw new Error('A single-model brief is separate from dialogue mode.');
  }
  for (const key of ['max_provider_calls', 'provider_timeout_ms'] as const) {
    const value = body[key];
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    ) {
      throw new Error(`Invalid ${key}.`);
    }
  }
  return {
    speaker,
    ...(speaker !== 'scripted' && (provider === 'claude' || provider === 'codex')
      ? { provider }
      : {}),
    single_pass: singlePass,
    ...(singlePass ? { max_rounds: 1 } : {}),
    max_provider_calls:
      speaker === 'scripted'
        ? 0
        : singlePass
          ? 1
          : Math.min(
              32,
              Math.max(
                1,
                typeof body.max_provider_calls === 'number' ? body.max_provider_calls : 32
              )
            ),
    provider_timeout_ms: Math.min(
      60_000,
      Math.max(
        1000,
        typeof body.provider_timeout_ms === 'number' ? body.provider_timeout_ms : 60_000
      )
    ),
  };
}

export function discussionExecutionState(room: Pick<DiscussionRoomState, 'execution'>) {
  const execution = room.execution;
  if (!execution || execution.actual_mode === 'unknown') return 'unknown' as const;
  if (execution.actual_mode === 'scripted') return 'scripted' as const;
  return execution.provider ? ('confirmed' as const) : ('unconfirmed' as const);
}
