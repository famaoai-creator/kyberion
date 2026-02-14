#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { getAllFiles } = require('../../scripts/lib/fs-utils.cjs');
const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Project directory' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

function findDataSources(dir) {
  const sources = [];
  const allFiles = getAllFiles(dir, { maxDepth: 4 });
  for (const full of allFiles) {
    if (!['.js', '.cjs', '.ts', '.py', '.go', '.java'].includes(path.extname(full))) continue;
    try {
      const content = fs.readFileSync(full, 'utf8');
      const rel = path.relative(dir, full);
      if (/(?:readFile|createReadStream|fs\.read|open\()/i.test(content))
        sources.push({ file: rel, type: 'file_read', flow: 'input' });
      if (/(?:writeFile|createWriteStream|fs\.write)/i.test(content))
        sources.push({ file: rel, type: 'file_write', flow: 'output' });
      if (/(?:SELECT|INSERT|UPDATE|DELETE|CREATE TABLE)/i.test(content))
        sources.push({ file: rel, type: 'database', flow: 'bidirectional' });
      if (/(?:fetch|axios|http\.get|request\()/i.test(content))
        sources.push({ file: rel, type: 'api_call', flow: 'input' });
      if (/(?:res\.json|res\.send|response\.write)/i.test(content))
        sources.push({ file: rel, type: 'api_response', flow: 'output' });
      if (/(?:localStorage|sessionStorage|cookie)/i.test(content))
        sources.push({ file: rel, type: 'browser_storage', flow: 'bidirectional' });
      if (/(?:process\.env|dotenv)/i.test(content))
        sources.push({ file: rel, type: 'environment', flow: 'input' });
    } catch (_e) {}
  }
  return sources;
}

function checkGDPRCompliance(sources) {
  const concerns = [];
  const hasPersonalData = sources.some(
    (s) => s.type === 'database' || s.type === 'browser_storage'
  );
  if (hasPersonalData) {
    concerns.push({
      rule: 'Right to be Forgotten',
      status: 'verify',
      detail: 'Database/storage access detected - ensure deletion capabilities exist',
    });
    concerns.push({
      rule: 'Data Minimization',
      status: 'verify',
      detail: 'Verify only necessary data is collected and stored',
    });
    concerns.push({
      rule: 'Consent',
      status: 'verify',
      detail: 'Ensure user consent is obtained before data processing',
    });
  }
  const apiCalls = sources.filter((s) => s.type === 'api_call');
  if (apiCalls.length > 0)
    concerns.push({
      rule: 'Data Transfer',
      status: 'verify',
      detail: `${apiCalls.length} external API calls found - verify data transfer compliance`,
    });
  return concerns;
}

function buildLineageGraph(sources) {
  const nodes = [...new Set(sources.map((s) => s.file))].map((f) => ({ id: f, type: 'file' }));
  const edges = [];
  const inputs = sources.filter((s) => s.flow === 'input' || s.flow === 'bidirectional');
  const outputs = sources.filter((s) => s.flow === 'output' || s.flow === 'bidirectional');
  for (const inp of inputs) {
    for (const out of outputs) {
      if (inp.file === out.file)
        edges.push({ from: `${inp.type}_source`, to: inp.file, via: out.type });
    }
  }
  return { nodes: nodes.slice(0, 30), edges: edges.slice(0, 50) };
}

runSkill('data-lineage-guardian', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);
  const sources = findDataSources(targetDir);
  const gdpr = checkGDPRCompliance(sources);
  const lineage = buildLineageGraph(sources);
  const result = {
    directory: targetDir,
    dataSources: sources.slice(0, 50),
    sourceCount: sources.length,
    dataFlowSummary: {
      inputs: sources.filter((s) => s.flow === 'input').length,
      outputs: sources.filter((s) => s.flow === 'output').length,
      bidirectional: sources.filter((s) => s.flow === 'bidirectional').length,
    },
    gdprConcerns: gdpr,
    lineageGraph: lineage,
    recommendations: gdpr.map((c) => `[${c.status}] ${c.rule}: ${c.detail}`),
  };
  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
