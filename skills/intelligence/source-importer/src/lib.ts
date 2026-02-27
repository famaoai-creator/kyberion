import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pathResolver from '@agent/core/path-resolver';

export interface SourceEntry {
  id: string;
  url: string;
  importedAt: string;
  status: 'verified' | 'quarantined';
  scanResult: string;
  localPath: string;
}

export interface Registry {
  sources: SourceEntry[];
}

export async function importSource(repoUrl: string, name?: string): Promise<SourceEntry> {
  const repoName = name || path.basename(repoUrl, '.git');
  const quarantineDir = path.join(pathResolver.activeRoot(), 'quarantine', repoName);
  const registryPath = pathResolver.shared('registry/source_registry.json');

  if (fs.existsSync(quarantineDir)) {
    execSync(`git pull`, { cwd: quarantineDir, stdio: 'ignore' });
  } else {
    fs.mkdirSync(path.dirname(quarantineDir), { recursive: true });
    execSync(`git clone --depth 1 ${repoUrl} ${quarantineDir}`, { stdio: 'ignore' });
  }

  let scanResult = 'Not scanned';
  try {
    // Invoke security-scanner via CLI (Architecture standard for intra-skill calling)
    const scanOutput = execSync(
      `node scripts/cli.cjs run security-scanner --dir ${quarantineDir}`,
      { encoding: 'utf8' }
    );
    scanResult = scanOutput.includes('findingCount: 0') ? 'Passed' : 'Warning: Issues Found';
  } catch (_e) {
    // Scan tool failed
  }

  const registry: Registry = fs.existsSync(registryPath)
    ? JSON.parse(safeReadFile(registryPath, 'utf8'))
    : { sources: [] };

  const entry: SourceEntry = {
    id: repoName,
    url: repoUrl,
    importedAt: new Date().toISOString(),
    status: scanResult === 'Passed' ? 'verified' : 'quarantined',
    scanResult,
    localPath: quarantineDir,
  };

  const existingIdx = registry.sources.findIndex((s) => s.id === repoName);
  if (existingIdx !== -1) registry.sources[existingIdx] = entry;
  else registry.sources.push(entry);

  if (!fs.existsSync(path.dirname(registryPath))) {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  }
  safeWriteFile(registryPath, JSON.stringify(registry, null, 2));

  return entry;
}
