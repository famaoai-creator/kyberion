import { describe, expect, it } from 'vitest';

import { extractMissionControllerPositionalArgs } from '../scripts/refactor/mission-cli-args.js';
import { resolveMissionTicketDispatchOptionsFromArgv, resolveMissionWorkItemDispatchOptionsFromArgv } from '../scripts/mission_controller.js';

describe('extractMissionControllerPositionalArgs', () => {
  it('skips persona and other value flags from positional args', () => {
    const argv = [
      'node',
      'scripts/mission_controller.ts',
      'create',
      'PDF-TO-PPTX-CONVERSION',
      'confidential',
      '--persona',
      'media_specialist',
      '--tenant-id',
      'tenant-a',
      '--vision-ref',
      '/customer/demo/my-vision.md',
      '--project-id',
      'proj-123',
    ];

    expect(extractMissionControllerPositionalArgs(argv)).toEqual([
      'create',
      'PDF-TO-PPTX-CONVERSION',
      'confidential',
    ]);
  });

  it('resolves dispatch ticket options from argv', () => {
    const argv = [
      'node',
      'scripts/mission_controller.ts',
      'dispatch-tickets',
      'MSN-123',
      '--ticket-targets',
      'workitem,github,jira',
      '--live-ticket-targets',
      'github',
      '--github-owner',
      'famaoai-creator',
      '--github-repo',
      'kyberion',
      '--jira-domain',
      'kyberion.atlassian.net',
      '--jira-project-key',
      'KYB',
    ];

    expect(resolveMissionTicketDispatchOptionsFromArgv(argv)).toEqual({
      targets: ['workitem', 'github', 'jira'],
      liveTargets: ['github'],
      github: {
        owner: 'famaoai-creator',
        repo: 'kyberion',
      },
      jira: {
        domain: 'kyberion.atlassian.net',
        projectKey: 'KYB',
      },
    });
  });

  it('resolves dispatch workitem options from argv', () => {
    const argv = [
      'node',
      'scripts/mission_controller.ts',
      'dispatch-workitems',
      'MSN-123',
      '--dispatch-mode',
      'subagent',
      '--dispatch-statuses',
      'ready,backlog',
      '--dispatch-sources',
      'local,github',
      '--dispatch-final-status',
      'done',
      '--dispatch-limit',
      '3',
    ];

    expect(resolveMissionWorkItemDispatchOptionsFromArgv(argv)).toEqual({
      mode: 'subagent',
      limit: 3,
      statuses: ['ready', 'backlog'],
      sources: ['local', 'github'],
      finalStatus: 'done',
    });
  });
});
