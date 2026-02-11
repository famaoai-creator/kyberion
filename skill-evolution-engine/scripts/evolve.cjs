#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
 const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { walk, getAllFiles } = require('../../scripts/lib/fs-utils.cjs');
const argv = createStandardYargs()
  .option('skill', { alias: 's', type: 'string', demandOption: true, description: 'Skill name to analyze for evolution' })
  .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Project root' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

function analyzeSkillHealth(skillDir) {
  const health = { hasScript: false, hasSkillMd: false, hasPackageJson: false, scriptSize: 0, complexity: 'unknown' };
  if (fs.existsSync(path.join(skillDir, 'scripts'))) {
    const scripts = fs.readdirSync(path.join(skillDir, 'scripts')).filter(f => f.endsWith('.cjs') || f.endsWith('.js'));
    health.hasScript = scripts.length > 0;
    if (health.hasScript) {
      const content = fs.readFileSync(path.join(skillDir, 'scripts', scripts[0]), 'utf8');
      health.scriptSize = content.split('\n').length;
      const fnCount = (content.match(/function\s+\w+/g) || []).length;
      health.complexity = fnCount > 10 ? 'high' : fnCount > 5 ? 'medium' : 'low';
      health.functionCount = fnCount;
    }
  }
  health.hasSkillMd = fs.existsSync(path.join(skillDir, 'SKILL.md'));
  health.hasPackageJson = fs.existsSync(path.join(skillDir, 'package.json'));
  return health;
}

function suggestEvolutions(skillName, health) {
  const suggestions = [];
  if (health.scriptSize > 300) suggestions.push({ type: 'refactor', priority: 'medium', suggestion: 'Script is large - consider splitting into modules' });
  if (!health.hasPackageJson) suggestions.push({ type: 'structure', priority: 'low', suggestion: 'Add package.json for dependency management' });
  if (health.complexity === 'high') suggestions.push({ type: 'simplify', priority: 'high', suggestion: `${health.functionCount} functions - consider extracting to shared lib` });
  suggestions.push({ type: 'enhance', priority: 'low', suggestion: 'Add input validation with validators.cjs' });
  suggestions.push({ type: 'enhance', priority: 'low', suggestion: 'Add metrics tracking with MetricsCollector' });
  return suggestions;
}

function checkWorkLogs(dir, skillName) {
  const workDir = path.join(dir, 'work');
  const logs = [];
  if (fs.existsSync(workDir)) {
    function walk(d, depth) {
      if (depth > 2) return;
      try {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) { walk(full, depth + 1); continue; }
          if (!e.name.endsWith('.json')) continue;
          try {
            const data = JSON.parse(fs.readFileSync(full, 'utf8'));
            if (data.skill === skillName) logs.push({ file: path.relative(dir, full), status: data.status, timestamp: data.metadata?.timestamp });
          } catch(_e){}
        }
      } catch(_e){}
    }
    walk(workDir, 0);
  }
  return logs;
}

runSkill('skill-evolution-engine', () => {
  const targetDir = path.resolve(argv.dir);
  const skillDir = path.join(targetDir, argv.skill);
  if (!fs.existsSync(skillDir)) throw new Error(`Skill directory not found: ${skillDir}`);
  const health = analyzeSkillHealth(skillDir);
  const suggestions = suggestEvolutions(argv.skill, health);
  const logs = checkWorkLogs(targetDir, argv.skill);
  const successRate = logs.length > 0 ? Math.round(logs.filter(l => l.status === 'success').length / logs.length * 100) : null;
  const result = {
    skill: argv.skill, health, executionHistory: { runs: logs.length, successRate },
    evolutionSuggestions: suggestions,
    recommendations: suggestions.filter(s => s.priority === 'high').map(s => `[${s.priority}] ${s.suggestion}`),
  };
  if (argv.out) fs.writeFileSync(argv.out, JSON.stringify(result, null, 2));
  return result;
});
