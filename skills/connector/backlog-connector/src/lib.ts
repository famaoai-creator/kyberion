import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export function getBacklogApiKey(credsPath: string, pattern: string): string {
  if (!fs.existsSync(credsPath)) throw new Error('Backlog credentials not found');
  const content = safeReadFile(credsPath, 'utf8');
  const match = content.match(new RegExp(pattern));
  if (!match || !match[1]) throw new Error('API Key not found in credentials');
  return match[1];
}

export function fetchBacklogIssues(
  spaceUrl: string,
  endpoint: string,
  apiKey: string,
  projectId: string
): any[] {
  const url =
    spaceUrl + endpoint + '?apiKey=' + apiKey + '&projectId[]=' + projectId + '&count=100';
  const response = execSync('curl -s "' + url + '"', { encoding: 'utf8' });
  return JSON.parse(response);
}
