import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAllFiles } from '@agent/core/fs-utils';

export interface SkillHealth {
  hasScript: boolean;
  hasSkillMd: boolean;
  hasPackageJson: boolean;
  scriptSize: number;
  complexity: 'low' | 'medium' | 'high' | 'unknown';
  functionCount?: number;
}

export interface EvolutionSuggestion {
  type: string;
  priority: 'low' | 'medium' | 'high';
  suggestion: string;
}

export interface WorkLog {
  file: string;
  status: string;
  timestamp?: string;
}

export function analyzeSkillHealth(skillDir: string): SkillHealth {
  const health: SkillHealth = {
    hasScript: false,
    hasSkillMd: false,
    hasPackageJson: false,
    scriptSize: 0,
    complexity: 'unknown',
  };
  const scriptsDir = path.join(skillDir, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    const scripts = fs
      .readdirSync(scriptsDir)
      .filter((f) => f.endsWith('.cjs') || f.endsWith('.js'));
    health.hasScript = scripts.length > 0;
    if (health.hasScript) {
      const content = safeReadFile(path.join(scriptsDir, scripts[0]), 'utf8');
      health.scriptSize = content.split(new RegExp('\\r?\\n')).length;
      const fnCount = (content.match(/function\s+\w+/g) || []).length;
      health.complexity = fnCount > 10 ? 'high' : fnCount > 5 ? 'medium' : 'low';
      health.functionCount = fnCount;
    }
  }
  health.hasSkillMd = fs.existsSync(path.join(skillDir, 'SKILL.md'));
  health.hasPackageJson = fs.existsSync(path.join(skillDir, 'package.json'));
  return health;
}

export function suggestEvolutions(_skillName: string, health: SkillHealth): EvolutionSuggestion[] {
  const suggestions: EvolutionSuggestion[] = [];
  if (health.scriptSize > 300) {
    suggestions.push({
      type: 'refactor',
      priority: 'medium',
      suggestion: 'Script is large - consider splitting into modules',
    });
  }
  if (!health.hasPackageJson) {
    suggestions.push({
      type: 'structure',
      priority: 'low',
      suggestion: 'Add package.json for dependency management',
    });
  }
  if (health.complexity === 'high') {
    suggestions.push({
      type: 'simplify',
      priority: 'high',
      suggestion: `${health.functionCount} functions - consider extracting to shared lib`,
    });
  }
  suggestions.push({
    type: 'enhance',
    priority: 'low',
    suggestion: 'Add input validation with validators.cjs',
  });
  suggestions.push({
    type: 'enhance',
    priority: 'low',
    suggestion: 'Add metrics tracking with MetricsCollector',
  });
  return suggestions;
}

export function checkWorkLogs(dir: string, skillName: string): WorkLog[] {
  const workDir = path.join(dir, 'work');
  const logs: WorkLog[] = [];
  if (fs.existsSync(workDir)) {
    const allFiles = getAllFiles(workDir, { maxDepth: 2 });
    for (const full of allFiles) {
      if (!full.endsWith('.json')) continue;
      try {
        const data = JSON.parse(safeReadFile(full, 'utf8'));
        if (data.skill === skillName) {
          logs.push({
            file: path.relative(dir, full),
            status: data.status,
            timestamp: data.metadata?.timestamp,
          });
        }
      } catch (_e) {
        // ignore
      }
    }
  }
  return logs;
}
