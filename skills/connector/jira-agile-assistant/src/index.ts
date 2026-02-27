import { runSkillAsync } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as pathResolver from '@agent/core/path-resolver';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { JiraClient } from './jira-client.js';

const argv = createStandardYargs()
  .option('action', {
    alias: 'a',
    type: 'string',
    choices: ['get-issue', 'create-issue'],
  })
  .option('input', { alias: 'i', type: 'string' })
  .option('issue-key', { type: 'string' })
  .option('dry-run', { type: 'boolean', default: false }).argv;

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkillAsync('jira-agile-assistant', async () => {
    const rootDir = pathResolver.rootDir();
    const client = new JiraClient(rootDir);
    let actionResult: any;

    const inputData = argv.input
      ? JSON.parse(fs.readFileSync(path.resolve(argv.input as string), 'utf8'))
      : {};

    switch (argv.action) {
      case 'get-issue':
        const key = (argv['issue-key'] as string) || inputData.issueKey;
        if (!key) throw new Error('Issue key required');
        actionResult = await client.getIssue(key);
        break;
      case 'create-issue':
        const fields = inputData.fields || inputData;
        if (argv['dry-run']) {
          actionResult = { key: 'DRY-RUN-123', status: 'simulated' };
        } else {
          actionResult = await client.createIssue(fields);
        }
        break;
      default:
        throw new Error('Unsupported action');
    }

    return actionResult;
  });
}
