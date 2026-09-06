import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import { loadMissionTicketProviderArtifactAtPath } from './mission-ticket-provider-artifact.js';

const root = pathResolver.sharedTmp(`mission-ticket-provider-artifact-${process.pid}`);

afterEach(() => {
  safeRmSync(root, { recursive: true, force: true });
});

describe('mission ticket provider artifact loader', () => {
  it('loads GitHub and Jira reflection artifacts through provider schemas', () => {
    const githubPath = path.join(root, 'github.json');
    const jiraPath = path.join(root, 'jira.json');
    safeMkdir(root, { recursive: true });
    safeWriteFile(githubPath, JSON.stringify({ title: 'Issue', state: 'open' }));
    safeWriteFile(jiraPath, JSON.stringify({ key: 'PRJ-1', fields: { summary: 'Issue' } }));

    expect(loadMissionTicketProviderArtifactAtPath(githubPath, 'github')).toEqual({
      title: 'Issue',
      state: 'open',
    });
    expect(loadMissionTicketProviderArtifactAtPath(jiraPath, 'jira')).toEqual({
      key: 'PRJ-1',
      fields: { summary: 'Issue' },
    });
  });

  it('rejects malformed provider artifacts', () => {
    const githubPath = path.join(root, 'github.json');
    const jiraPath = path.join(root, 'jira.json');
    safeMkdir(root, { recursive: true });
    safeWriteFile(githubPath, JSON.stringify({ state: 'open' }));
    safeWriteFile(jiraPath, JSON.stringify({ key: 'PRJ-1' }));

    expect(() => loadMissionTicketProviderArtifactAtPath(githubPath, 'github')).toThrow(
      /Invalid catalog mission-github-ticket-artifact/u
    );
    expect(() => loadMissionTicketProviderArtifactAtPath(jiraPath, 'jira')).toThrow(
      /Invalid catalog mission-jira-ticket-artifact/u
    );
  });

  it('rejects symlinked provider artifacts before JSON read', () => {
    const outside = path.join(root, 'outside');
    const link = path.join(root, 'github.json');
    safeMkdir(outside, { recursive: true });
    safeWriteFile(
      path.join(outside, 'real.json'),
      JSON.stringify({ title: 'Issue', state: 'open' })
    );
    safeSymlinkSync(path.join(outside, 'real.json'), link);

    expect(() => loadMissionTicketProviderArtifactAtPath(link, 'github')).toThrow(
      '[RESOURCE_PATH_SYMLINK]'
    );
  });
});
