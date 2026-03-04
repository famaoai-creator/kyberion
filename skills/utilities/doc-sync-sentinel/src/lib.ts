import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Doc-Sync Sentinel Core Library.
 */

export interface SyncStatus {
  file: string;
  synced: boolean;
  lastUpdated: string;
}

export function checkSync(srcFile: string, targetFile: string): SyncStatus {
  if (!fs.existsSync(srcFile) || !fs.existsSync(targetFile)) {
    return { file: path.basename(srcFile), synced: false, lastUpdated: 'never' };
  }

  const srcStat = fs.statSync(srcFile);
  const targetStat = fs.statSync(targetFile);

  return {
    file: path.basename(srcFile),
    synced: targetStat.mtime >= srcStat.mtime,
    lastUpdated: targetStat.mtime.toISOString()
  };
}

export function getRecentChanges(dir: string, days: number): string[] {
  const files = fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile());
  const threshold = Date.now() - (days * 24 * 60 * 60 * 1000);
  
  return files.filter(f => {
    const stat = fs.statSync(path.join(dir, f));
    return stat.mtimeMs > threshold;
  });
}
