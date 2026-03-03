const chalk: any = require('chalk').default || require('chalk');
import * as fs from 'node:fs';
import * as path from 'node:path';
// chalk imported dynamically
import { safeWriteFile, safeReadFile } from '@agent/core';

const rootDir = process.cwd();
const indexPath = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');
const outputPath = path.join(rootDir, 'docs/architecture/dependency-graph.mmd');

interface SkillEntry {
  n: string;
  path: string;
  [key: string]: any;
}

interface SkillIndex {
  s: SkillEntry[];
  [key: string]: any;
}

function generate(): void {
  if (!fs.existsSync(indexPath)) return;
  const indexRaw = safeReadFile(indexPath, { encoding: 'utf8' }) as string;
  const index: SkillIndex = JSON.parse(indexRaw);
  const skills = index.s || index.skills;

  let md = 'graph TD\n';
  md += '  subgraph Ecosystem ["Gemini Skills Ecosystem"]\n';

  const namespaces: Record<string, string[]> = {};
  skills.forEach((s) => {
    const sPath = s.path;
    const parts = sPath.split('/');
    const cat = parts.length > 1 ? parts[1] : 'General';
    if (!namespaces[cat]) namespaces[cat] = [];
    namespaces[cat].push(s.n);
  });

  Object.keys(namespaces)
    .sort()
    .forEach((ns) => {
      md += `    subgraph ${ns} ["📂 ${ns.toUpperCase()}"]\n`;
      namespaces[ns].forEach((skill) => {
        md += `      ${skill.replace(/-/g, '_')}["${skill}"]\n`;
      });
      md += '    end\n';
    });
  md += '  end\n';

  md += '  Infrastructure["🏛️ @agent/core (libs/core)"]\n';
  Object.keys(namespaces).forEach((ns) => {
    md += `  ${ns} -.-> Infrastructure\n`;
  });

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  
  safeWriteFile(outputPath, md);
  safeWriteFile(path.join(rootDir, 'dependency-graph.mmd'), md);

  console.log(chalk.green('✔ Architecture map regenerated.'));
}

generate();
