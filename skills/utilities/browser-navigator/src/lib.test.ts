import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runScenario } from './lib';

// Mock playwright as runScenario uses chromium.launch directly
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue({
      newContext: vi.fn().mockResolvedValue({
        newPage: vi.fn().mockResolvedValue({
          goto: vi.fn().mockResolvedValue({}),
          locator: vi.fn().mockReturnValue({
            first: vi.fn().mockReturnValue({
              scrollIntoViewIfNeeded: vi.fn().mockResolvedValue({}),
              click: vi.fn().mockResolvedValue({}),
              fill: vi.fn().mockResolvedValue({}),
            }),
            press: vi.fn().mockResolvedValue({}),
          }),
          waitForTimeout: vi.fn().mockResolvedValue({}),
          evaluate: vi.fn().mockResolvedValue('extracted data'),
          screenshot: vi.fn().mockResolvedValue({}),
          title: vi.fn().mockResolvedValue('Test Title'),
          url: vi.fn().mockReturnValue('http://test.com'),
        }),
      }),
      close: vi.fn().mockResolvedValue({}),
    }),
  },
}));

// Mock fs as runScenario reads scenario file
vi.mock('node:fs', () => ({
  readFileSync: vi.fn().mockReturnValue(JSON.stringify({
    name: 'Test Scenario',
    steps: [{ action: 'goto', url: 'http://example.com' }]
  })),
}));

describe('browser-navigator lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should run scenario', async () => {
    const result = await runScenario('test.json');
    expect(result.status).toBe('success');
  });
});
