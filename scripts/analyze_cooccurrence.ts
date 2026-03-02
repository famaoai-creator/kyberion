import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { safeWriteFile, safeReadFile } from '@agent/core';
import * as pathResolver from '@agent/core/path-resolver';

const rootDir = process.cwd();
const pipelineDir = path.join(rootDir, 'pipelines');

/**
 * Skill Co-occurrence Analyzer
 * Discovers relationships between skills by analyzing mission pipelines.
 */

interface PipelineDef {
  steps?: { skill: string }[];
}

interface SkillFrontmatter {
  related_skills?: string[];
  [key: string]: any;
}

function analyze(): void {
  if (!fs.existsSync(pipelineDir)) return;

  const pipelines = fs
    .readdirSync(pipelineDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  
  const graph: Record<string, Set<string>> = {};

  pipelines.forEach((file) => {
    try {
      const def = yaml.load(fs.readFileSync(path.join(pipelineDir, file), 'utf8')) as PipelineDef;
      if (def.steps && Array.isArray(def.steps)) {
        const skillsInPipeline = def.steps.map((step) => step.skill).filter(Boolean);

        skillsInPipeline.forEach((skill) => {
          if (!graph[skill]) graph[skill] = new Set();
          skillsInPipeline.forEach((related) => {
            if (skill !== related) graph[skill].add(related);
          });
        });
      }
    } catch (_) {}
  });

  console.log(`Discovered relationships for ${Object.keys(graph).length} skills.`);

  for (const [skill, relatedSet] of Object.entries(graph)) {
    // Resolve skill path dynamically
    const skillFullDir = pathResolver.skillDir(skill);
    if (!skillFullDir) continue;

    const skillMdPath = path.join(skillFullDir, 'SKILL.md');
    
    if (fs.existsSync(skillMdPath)) {
      const content = safeReadFile(skillMdPath, 'utf8') as string;
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
      
      if (fmMatch) {
        try {
          const fm = yaml.load(fmMatch[1]) as SkillFrontmatter;
          const related = Array.from(relatedSet).sort();

          if (JSON.stringify(fm.related_skills) !== JSON.stringify(related)) {
            fm.related_skills = related;
            const newFm = yaml.dump(fm, { lineWidth: -1 }).trim();
            const newContent = content.replace(/^---\n[\s\S]*?\n---/m, `---\n${newFm}\n---`);
            safeWriteFile(skillMdPath, newContent);
            console.log(`  [${skill}] Linked to: ${related.join(', ')}`);
          }
        } catch (_) {}
      }
    }
  }
}

analyze();
