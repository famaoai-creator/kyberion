import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkGoogleAuth, draftEmail } from './lib';
import * as fs from 'node:fs';

vi.mock('node:fs');

describe('google-workspace-integrator lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should detect auth if file exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const status = checkGoogleAuth('/root');
    expect(status.configured).toBe(true);
  });

  it('should draft email from input', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ subject: 'Test', content: 'Hello' })
    );
    const draft = draftEmail('in.json', 'to@test.com');
    expect(draft.subject).toBe('Test');
    expect(draft.to).toBe('to@test.com');
  });
});
