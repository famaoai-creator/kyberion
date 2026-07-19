import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./core.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import {
  DynamicInjectionRegistry,
  buildWorkingPrinciplesInjectionProvider,
  getDefaultDynamicInjectionRegistry,
  mergeAdjacentSameRoleMessages,
  renderInjectionsAsSystemReminders,
  resetDefaultDynamicInjectionRegistry,
} from './dynamic-injection.js';
import { buildWorkingPrinciplesLines } from './working-principles.js';
import { compactWorkerContext } from './worker-context-compaction.js';

beforeEach(() => resetDefaultDynamicInjectionRegistry());
afterEach(() => resetDefaultDynamicInjectionRegistry());

describe('DynamicInjectionRegistry', () => {
  it('throttles a provider inside its interval and re-allows after it', () => {
    const registry = new DynamicInjectionRegistry();
    registry.register({
      id: 'reminder',
      throttleMs: 1_000,
      collect: () => 'remember the thing',
    });

    expect(registry.collect({}, 0)).toHaveLength(1);
    expect(registry.collect({}, 500)).toHaveLength(0);
    expect(registry.collect({}, 1_500)).toHaveLength(1);
  });

  it('one-shot providers fire once and re-fire exactly once after compaction reset', () => {
    const registry = new DynamicInjectionRegistry();
    registry.register(
      buildWorkingPrinciplesInjectionProvider(() => buildWorkingPrinciplesLines('implementer'))
    );

    const first = registry.collect();
    expect(first).toHaveLength(1);
    expect(first[0].text).toContain('## Working principles');
    expect(registry.collect()).toHaveLength(0);

    registry.notifyContextCompacted();
    expect(registry.collect()).toHaveLength(1);
    expect(registry.collect()).toHaveLength(0);
  });

  it('is fail-open: a throwing provider is skipped, others still inject', () => {
    const registry = new DynamicInjectionRegistry();
    registry.register({
      id: 'broken',
      collect: () => {
        throw new Error('provider exploded');
      },
    });
    registry.register({ id: 'healthy', collect: () => 'still here' });

    const collected = registry.collect();
    expect(collected.map((injection) => injection.providerId)).toEqual(['healthy']);
  });

  it('rejects duplicate provider ids and supports unregistration', () => {
    const registry = new DynamicInjectionRegistry();
    const unregister = registry.register({ id: 'p', collect: () => 'x' });
    expect(() => registry.register({ id: 'p', collect: () => 'y' })).toThrow('[INJECTION_CONFIG]');
    unregister();
    expect(registry.providerCount).toBe(0);
  });
});

describe('history normalization + rendering', () => {
  it('merges adjacent same-role messages so injections never fragment history', () => {
    const merged = mergeAdjacentSameRoleMessages([
      { role: 'user', content: 'task' },
      { role: 'user', content: '<system-reminder>hint</system-reminder>' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'next' },
    ]);
    expect(merged).toHaveLength(3);
    expect(merged[0].content).toContain('task');
    expect(merged[0].content).toContain('hint');
  });

  it('renders collected injections as system-reminder blocks', () => {
    const rendered = renderInjectionsAsSystemReminders([
      { providerId: 'a', text: 'one' },
      { providerId: 'b', text: 'two' },
    ]);
    expect(rendered).toBe('<system-reminder>one</system-reminder>\n<system-reminder>two</system-reminder>');
  });
});

describe('compaction integration (KC-08 acceptance)', () => {
  it('a forced compaction resets the default registry so one-shots re-fire', async () => {
    const registry = getDefaultDynamicInjectionRegistry();
    registry.register(
      buildWorkingPrinciplesInjectionProvider(() => buildWorkingPrinciplesLines())
    );
    expect(registry.collect()).toHaveLength(1);
    expect(registry.collect()).toHaveLength(0);

    await compactWorkerContext(
      [
        { role: 'user', content: 'long history '.repeat(50) },
        { role: 'assistant', content: 'reply' },
      ],
      { force: true }
    );

    expect(registry.collect()).toHaveLength(1);
  });
});
