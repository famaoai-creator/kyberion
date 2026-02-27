import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JiraClient } from './jira-client';
import * as fs from 'node:fs';
import * as https from 'node:https';

vi.mock('node:fs');
vi.mock('node:https');

describe('jira-agile-assistant lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should initialize client if config exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ email: 'a@b.com', api_token: 'tk', host: 'https://h.atlassian.net' })
    );
    const client = new JiraClient('/root');
    expect(client).toBeDefined();
  });
});
