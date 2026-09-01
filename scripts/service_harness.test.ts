import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handleAction: vi.fn(),
}));

vi.mock('../libs/actuators/service-actuator/src/service-actuator-helpers.js', () => ({
  handleAction: mocks.handleAction,
}));

describe('service_harness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses explicit argv and emits through the harness printer', async () => {
    const result = { service_id: 'demo', status: 'ok' };
    mocks.handleAction.mockResolvedValue(result);

    const { main } = await import('./service_harness.js');
    const print = vi.fn();
    await main(['--service', 'demo', '--action', 'describe'], print);

    expect(mocks.handleAction).toHaveBeenCalledWith({
      service_id: 'demo',
      mode: 'HARNESS',
      action: 'describe',
      params: { detail: true },
    });
    expect(print).toHaveBeenCalledWith(result);
  });

  it('accepts the pnpm separator when parsing explicit argv', async () => {
    mocks.handleAction.mockResolvedValue({ ok: true });

    const { main } = await import('./service_harness.js');
    await main(['--', '--service', 'demo', '--action', 'describe'], vi.fn());

    expect(mocks.handleAction).toHaveBeenCalledWith(
      expect.objectContaining({ service_id: 'demo', action: 'describe' })
    );
  });
});
