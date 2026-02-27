import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { runSkill } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';
import * as pathResolver from '@agent/core/path-resolver';
import { classifyRepos } from './lib.js';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('github-repo-auditor', () => {
    const rootDir = pathResolver.rootDir();
    const configPath = path.join(
      rootDir,
      'knowledge/confidential/context/github-repo-auditor/config.json'
    );
    if (!fs.existsSync(configPath)) throw new Error('Config not found');

    const config = JSON.parse(safeReadFile(configPath, 'utf8'));
    const ORG = config.org;

    const rawData = execSync(
      'gh repo list ' + ORG + ' --limit 100 --json name,description,pushedAt,isArchived',
      { encoding: 'utf8' }
    );
    const repos = JSON.parse(rawData);

    const mapping = classifyRepos(repos);
    const result = { mapping, timestamp: new Date().toISOString() };

    safeWriteFile('work/github_audit_report.json', JSON.stringify(result, null, 2));
    return { status: 'success', categories: Object.keys(mapping).length };
  });
}
