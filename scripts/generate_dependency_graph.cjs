#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const rootDir = path.resolve(__dirname, '..');
const indexPath = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');
const outputPath = path.join(rootDir, 'docs/architecture/dependency-graph.mmd');

function generate() {
  if (!fs.existsSync(indexPath)) return;
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const skills = index.s || index.skills;

  let md = 'graph TD\n';
  md += '  subgraph Ecosystem ["Gemini Skills Ecosystem"]\n';

  const namespaces = {};
  skills.forEach((s) => {
    const sPath = s.path || s.n;
    const cat = sPath.split('/')[1] || 'General';
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

  if (!fs.existsSync(path.dirname(outputPath)))
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, md);
  fs.writeFileSync(path.join(rootDir, 'dependency-graph.mmd'), md);

  console.log(chalk.green('✔ Architecture map regenerated.'));
}

generate();
