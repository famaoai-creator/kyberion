const { safeWriteFile, safeReadFile } = require('@agent/core/secure-io');
import * as fs from 'node:fs';

export function checkWrapperUsage(scriptPath: string): boolean {
  try {
    const content = safeReadFile(scriptPath, 'utf8');
    return content.includes('runSkill') || content.includes('runAsyncSkill');
  } catch {
    return false;
  }
}

export function checkSkillMd(skillMdPath: string): string[] {
  const issues: string[] = [];
  try {
    const content = safeReadFile(skillMdPath, 'utf8');
    if (!content.includes('name:')) issues.push('Missing name');
    if (!content.includes('status:')) issues.push('Missing status');
  } catch {
    issues.push('Could not read SKILL.md');
  }
  return issues;
}
