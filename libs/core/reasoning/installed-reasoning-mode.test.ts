import { describe, expect, it } from 'vitest';
import {
  readInstalledReasoningMode,
  registerInstalledReasoningModeReader,
} from './installed-reasoning-mode.js';

describe('installed reasoning mode seam', () => {
  it('answers null until the reasoning bootstrap registers its reader', async () => {
    expect(readInstalledReasoningMode()).toBeNull();
    registerInstalledReasoningModeReader(() => 'claude-cli');
    expect(readInstalledReasoningMode()).toBe('claude-cli');
    // Loading the bootstrap registers the real reader (nothing installed in a test).
    await import('./reasoning-bootstrap.js');
    expect(readInstalledReasoningMode()).toBeNull();
  });
});
