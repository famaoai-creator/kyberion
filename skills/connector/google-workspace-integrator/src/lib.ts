const { safeWriteFile, safeReadFile } = require('@agent/core/secure-io');
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AuthStatus {
  configured: boolean;
  path: string | null;
}

export function checkGoogleAuth(rootDir: string): AuthStatus {
  const paths = [
    'knowledge/personal/connections/google/google-credentials.json',
    'knowledge/personal/google-credentials.json',
    'credentials.json',
  ];
  for (const p of paths) {
    const resolved = path.resolve(rootDir, p);
    if (fs.existsSync(resolved)) return { configured: true, path: resolved };
  }
  return { configured: false, path: null };
}

export function draftEmail(inputPath: string | undefined, to: string | undefined): any {
  let subject = 'Update',
    body = '';
  if (inputPath && fs.existsSync(inputPath)) {
    try {
      const data = JSON.parse(safeReadFile(inputPath, 'utf8'));
      subject = data.subject || data.title || 'Update';
      body = data.body || data.content || JSON.stringify(data, null, 2);
    } catch {
      body = safeReadFile(inputPath, 'utf8');
    }
  }
  return {
    to: to || 'stakeholders@company.com',
    subject,
    body: body.substring(0, 2000),
    format: 'text/plain',
  };
}
