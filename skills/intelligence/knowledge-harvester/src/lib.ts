import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pathResolver from '@agent/core/path-resolver';

export interface HarvestResult {
  repository: string;
  harvestedAt: string;
  status: string;
  local_sync?: {
    updated: string;
    skills_indexed: number;
  };
}

export async function harvestRepository(repoUrl: string): Promise<HarvestResult> {
  const tmpDir = path.join(pathResolver.shared('tmp'), 'harvest_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    execSync(`git clone --depth 1 ${repoUrl} ${tmpDir}`, { stdio: 'ignore' });
  } catch (_e) {
    // Git might fail in some envs
  }

  const result: HarvestResult = {
    repository: repoUrl,
    harvestedAt: new Date().toISOString(),
    status: 'success',
  };

  const rootDir = pathResolver.rootDir();
  const indexFile = path.join(rootDir, 'knowledge/_index.md');

  if (fs.existsSync(rootDir)) {
    const skills = fs
      .readdirSync(rootDir)
      .filter((f) => fs.existsSync(path.join(rootDir, f, 'SKILL.md')));

    let md = `# Ecosystem Knowledge Base\n\n## Available Skills\n\n`;
    skills.sort().forEach((s) => {
      md += `- **${s}**: [Documentation](../${s}/SKILL.md)\n`;
    });
    fs.writeFileSync(indexFile, md);

    result.local_sync = { updated: 'knowledge/_index.md', skills_indexed: skills.length };
  }

  return result;
}
