import { describe, expect, it } from 'vitest';
import { shouldCompileSurfaceIntent } from './surface-runtime-router.js';

function input(text: string) {
  return {
    surface: 'cli' as const,
    query: text,
    senderAgentId: 'test-surface',
    agentId: 'cli-surface-agent',
  };
}

describe('surface runtime intent gateway boundary', () => {
  it('compiles governed and unresolved requests before surface routing', () => {
    expect(
      shouldCompileSurfaceIntent(
        input('Webサービスを作って'),
        'Current incoming message:\nWebサービスを作って'
      )
    ).toBe(true);
    expect(
      shouldCompileSurfaceIntent(
        input('6/6-6/8で沖縄のホテルを探して'),
        'Current incoming message:\n6/6-6/8で沖縄のホテルを探して',
        'chronos-mirror'
      )
    ).toBe(true);
    expect(
      shouldCompileSurfaceIntent(input('zzzzzzzzqqqq'), 'Current incoming message:\nzzzzzzzzqqqq')
    ).toBe(true);
  });

  it('keeps lightweight direct replies on their deterministic route', () => {
    expect(
      shouldCompileSurfaceIntent(
        input('今日の天気を教えて'),
        'Current incoming message:\n今日の天気を教えて'
      )
    ).toBe(false);
  });

  it('does not let an explicit receiver bypass governed compilation', () => {
    expect(
      shouldCompileSurfaceIntent(
        { ...input('Webサービスを作って'), forcedReceiver: 'nerve-agent' },
        'Current incoming message:\nWebサービスを作って',
        'nerve-agent'
      )
    ).toBe(true);
    expect(
      shouldCompileSurfaceIntent(
        { ...input('zzzzzzzzqqqq'), forcedReceiver: 'nerve-agent' },
        'Current incoming message:\nzzzzzzzzqqqq',
        'nerve-agent'
      )
    ).toBe(true);
  });
});
