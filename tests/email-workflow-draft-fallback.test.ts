import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeExistsSync, safeReadFile, safeRmSync } from '@agent/core';

vi.mock('../libs/core/service-engine.js', () => ({
  executeServicePreset: vi.fn(async () => {
    throw new Error('gws unavailable');
  }),
}));

import { executeGmailDelivery, readEmailDraftArtifact, resolveEmailDraftDir } from '../libs/core/email-workflow.js';

describe('email workflow draft fallback', () => {
  afterEach(() => {
    safeRmSync(resolveEmailDraftDir(), { recursive: true, force: true });
  });

  it('writes a local draft artifact when gws draft delivery is unavailable', async () => {
    const result = await executeGmailDelivery({
      draft_mode: true,
      approved: false,
      body_markdown: 'Hello from a local fallback test.',
      subject: 'Fallback subject',
      to: 'test@example.com',
    });

    expect(result).toMatchObject({
      ok: true,
      fallback: true,
      backend: 'local-fallback',
      subject: 'Fallback subject',
      to: 'test@example.com',
    });
    expect(safeExistsSync(result.draft_path)).toBe(true);
    expect(safeExistsSync(result.json_path)).toBe(true);

    const artifact = readEmailDraftArtifact();
    expect(artifact.exists).toBe(true);
    expect(artifact.subject).toBe('Fallback subject');
    expect(artifact.to).toBe('test@example.com');
    expect(artifact.draft_markdown).toContain('Hello from a local fallback test.');
    expect(String(safeReadFile(result.json_path, { encoding: 'utf8' }))).toContain('local-fallback');
  });
});
