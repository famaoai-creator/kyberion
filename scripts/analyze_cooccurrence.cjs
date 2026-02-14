#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const rootDir = path.resolve(__dirname, '..');
const pipelineDir = path.join(rootDir, 'pipelines');

/**
 * Skill Co-occurrence Analyzer
 * Discovers relationships between skills by analyzing mission pipelines.
 */

function analyze() {
  if (!fs.existsSync(pipelineDir)) return;

  const pipelines = fs
    .readdirSync(pipelineDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const graph = {}; // skill -> Set of related skills

  pipelines.forEach((file) => {
    try {
      const def = yaml.load(fs.readFileSync(path.join(pipelineDir, file), 'utf8'));
      if (def.pipeline && Array.isArray(def.pipeline)) {
        const skillsInPipeline = def.pipeline.map((step) => step.skill);

        skillsInPipeline.forEach((skill) => {
          if (!graph[skill]) graph[skill] = new Set();
          skillsInPipeline.forEach((related) => {
            if (skill !== related) graph[skill].add(related);
          });
        });
      }
    } catch (_) {}
  });

  // Update SKILL.md files
  console.log(`Discovered relationships for ${Object.keys(graph).length} skills.`);

  for (const [skill, relatedSet] of Object.entries(graph)) {
    const skillMdPath = path.join(rootDir, skill, 'SKILL.md');
    if (fs.existsSync(skillMdPath)) {
      const content = fs.readFileSync(skillMdPath, 'utf8');
      // Fix: Safer regex construction
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
      if (fmMatch) {
        try {
          const fm = yaml.load(fmMatch[1]);
          const related = Array.from(relatedSet).sort();

          if (JSON.stringify(fm.related_skills) !== JSON.stringify(related)) {
            fm.related_skills = related;
            const newFm = yaml.dump(fm, { lineWidth: -1 }).trim();
            const newContent = content.replace(/^---\n[\s\S]*?\n---/m, '---\n' + newFm + '\n---');
            fs.writeFileSync(skillMdPath, newContent);
            console.log(`  [${skill}] Linked to: ${related.join(', ')}`);
          }
        } catch (_) {}
      }
    }
  }
}

analyze();
