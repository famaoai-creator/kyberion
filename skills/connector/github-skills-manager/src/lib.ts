import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GitStatus {
  branch: string;
  hasChanges: boolean;
  remote: boolean;
}

export interface SkillEntry {
  name: string;
  path: string;
  category: string;
  isInstalled: boolean;
  gitStatus: GitStatus | null;
}

const ROOT_DIR = path.resolve(__dirname, '../../../../');
const INDEX_PATH = path.join(ROOT_DIR, 'knowledge/orchestration/global_skill_index.json');

export function getGitStatus(dir: string): GitStatus | null {
  try {
    const gitDir = path.join(dir, '.git');
    if (!fs.existsSync(gitDir)) {
      // Check if root is git and this is a subdir
      try {
        const isInsideWorkTree = execSync('git rev-parse --is-inside-work-tree', { cwd: dir }).toString().trim() === 'true';
        if (!isInsideWorkTree) return null;
      } catch { return null; }
    }

    const status = execSync('git status --short', { cwd: dir }).toString().trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir }).toString().trim();
    const remote = execSync('git remote -v', { cwd: dir }).toString().trim();

    return {
      branch,
      hasChanges: status.length > 0,
      remote: remote.length > 0,
    };
  } catch {
    return null;
  }
}

export function getAllSkills(): SkillEntry[] {
  const skillsDir = path.join(ROOT_DIR, 'skills');
  const categories = fs.readdirSync(skillsDir).filter(f => fs.statSync(path.join(skillsDir, f)).isDirectory());
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  const installedSkills = new Set((index.s || index.skills).map((s: any) => s.n || s.name));

  const results: SkillEntry[] = [];

  categories.forEach(category => {
    const categoryDir = path.join(skillsDir, category);
    const skills = fs.readdirSync(categoryDir).filter(f => {
      const fullPath = path.join(categoryDir, f);
      return fs.statSync(fullPath).isDirectory() && fs.existsSync(path.join(fullPath, 'SKILL.md'));
    });

    skills.forEach(skillName => {
      const skillPath = path.join(categoryDir, skillName);
      results.push({
        name: skillName,
        path: path.relative(ROOT_DIR, skillPath),
        category,
        isInstalled: installedSkills.has(skillName),
        gitStatus: getGitStatus(skillPath)
      });
    });
  });

  return results;
}

export function syncSkill(skillPath: string): string {
  const fullPath = path.join(ROOT_DIR, skillPath);
  try {
    return execSync('git pull', { cwd: fullPath }).toString();
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

export function installSkill(skillPath: string): string {
  const fullPath = path.join(ROOT_DIR, skillPath);
  if (fs.existsSync(path.join(fullPath, 'package.json'))) {
    try {
      return execSync('npm install', { cwd: fullPath }).toString();
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }
  return 'No package.json found, skipping npm install.';
}

export function pushSkill(skillPath: string, message: string): string {
  const fullPath = path.join(ROOT_DIR, skillPath);
  try {
    execSync('git add .', { cwd: fullPath });
    execSync(`git commit -m "${message}"`, { cwd: fullPath });
    return execSync('git push', { cwd: fullPath }).toString();
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}
