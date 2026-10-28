import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  gate: vi.fn(async () => ({ available: true }) as { available: boolean; reason?: string }),
  prompt: vi.fn(async () => 'visible summary' as string | null),
  capabilities: vi.fn(async () => ({ os: { major: 27, minor: 2, patch: 0 } })),
}));
vi.mock('@agent/core/apple-intelligence-bridge', () => ({
  gateAppleLane: mocks.gate,
  appleFmPromptWithImage: mocks.prompt,
  probeAppleIntelligenceCapabilities: mocks.capabilities,
}));
import {
  SYSTEM_CAPTURE_OP_HANDLERS as handlers,
  opCapture,
} from './system-pipeline-core-helpers.js';
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.gate.mockResolvedValue({ available: true });
});
describe('Apple native capture ops', () => {
  it('apple_capabilities reports its probe without taking a screenshot', async () => {
    const capture = vi.spyOn(handlers, 'screenshot');
    const result = await opCapture('apple_capabilities', {}, {}, (value) => value);
    expect(result.apple_capabilities).toEqual({ os: { major: 27, minor: 2, patch: 0 } });
    expect(capture).not.toHaveBeenCalled();
  });
  it('ask_screen passes only the existing redacted screenshot result to the local model', async () => {
    const capture = vi
      .spyOn(handlers, 'screenshot')
      .mockResolvedValue({ screenshot_path: 'active/shared/tmp/redacted.png' });
    const result = await opCapture(
      'ask_screen',
      { question: 'What is visible?', application: 'Preview' },
      {},
      (value) => value
    );
    expect(capture).toHaveBeenCalledOnce();
    expect(mocks.prompt).toHaveBeenCalledWith(
      'What is visible?',
      'active/shared/tmp/redacted.png',
      { timeoutMs: 60000 }
    );
    expect(result.screen_answer).toEqual({
      available: true,
      answer: 'visible summary',
      screenshot_path: 'active/shared/tmp/redacted.png',
    });
  });
  it('ask_screen does not capture the screen when its model lane is unavailable', async () => {
    mocks.gate.mockResolvedValue({ available: false, reason: 'unsupported' });
    const capture = vi.spyOn(handlers, 'screenshot');
    const result = await opCapture(
      'ask_screen',
      { question: 'What is visible?' },
      {},
      (value) => value
    );
    expect(result.screen_answer).toEqual({ available: false, reason: 'unsupported' });
    expect(capture).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();
  });
  it('ask_screen stops before inference when screenshot redaction fails', async () => {
    vi.spyOn(handlers, 'screenshot').mockRejectedValue(new Error('redaction failed'));
    await expect(
      opCapture('ask_screen', { question: 'What is visible?' }, {}, (value) => value)
    ).rejects.toThrow('redaction failed');
    expect(mocks.prompt).not.toHaveBeenCalled();
  });
});
