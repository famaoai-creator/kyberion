import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkillAsync } from '@agent/core';
import { requireArgs } from '@agent/core/validators';
import * as pathResolver from '@agent/core/path-resolver';
import { getBacklogApiKey, fetchBacklogIssues } from './lib.js';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkillAsync('backlog-connector', async () => {
    const argv = requireArgs(['project']);
    const rootDir = pathResolver.rootDir();

    const configPath = path.join(rootDir, 'knowledge/skills/backlog-connector/config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    const inventoryPath = path.join(rootDir, 'knowledge/confidential/connections/inventory.json');
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));

    const credsPath = path.join(rootDir, 'knowledge/personal/connections/backlog.md');
    const apiKey = getBacklogApiKey(credsPath, config.credential_pattern);

    const projectInfo = inventory.systems.backlog.projects[argv.project as string];
    if (!projectInfo) throw new Error('Project ' + argv.project + ' not found in inventory.');

    const data = fetchBacklogIssues(
      inventory.systems.backlog.space_url,
      config.endpoints.issues,
      apiKey,
      projectInfo.id
    );

    return { project: argv.project, count: data.length };
  });
}
