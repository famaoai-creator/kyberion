#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const yargs = require('yargs/yargs'); const { hideBin } = require('yargs/helpers');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const argv = yargs(hideBin(process.argv))
  .option('current', { alias: 'c', type: 'string', demandOption: true, description: 'Path to current API spec (OpenAPI JSON/YAML)' })
  .option('previous', { alias: 'p', type: 'string', description: 'Path to previous API spec for diff' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

function parseSpec(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  try { return JSON.parse(content); } catch(_e) {
    // Simple YAML-like parsing for paths
    const paths = {}; const lines = content.split('\n');
    let currentPath = null;
    for (const line of lines) {
      const pathMatch = line.match(/^\s{2}(\/\S+):/);
      const methodMatch = line.match(/^\s{4}(get|post|put|delete|patch):/);
      if (pathMatch) currentPath = pathMatch[1];
      if (methodMatch && currentPath) { if (!paths[currentPath]) paths[currentPath] = []; paths[currentPath].push(methodMatch[1]); }
    }
    return { paths: Object.entries(paths).reduce((o, [p, methods]) => { o[p] = {}; methods.forEach(m => o[p][m] = {}); return o; }, {}) };
  }
}

function extractEndpoints(spec) {
  const endpoints = [];
  const paths = spec.paths || {};
  for (const [p, methods] of Object.entries(paths)) {
    for (const [method, config] of Object.entries(methods)) {
      if (['get','post','put','delete','patch','options','head'].includes(method)) {
        endpoints.push({ path: p, method: method.toUpperCase(), summary: config.summary || '', deprecated: config.deprecated || false, parameters: (config.parameters || []).length });
      }
    }
  }
  return endpoints;
}

function diffAPIs(currentEndpoints, previousEndpoints) {
  const changes = { added: [], removed: [], modified: [] };
  const prevMap = new Map(previousEndpoints.map(e => [`${e.method} ${e.path}`, e]));
  const currMap = new Map(currentEndpoints.map(e => [`${e.method} ${e.path}`, e]));
  for (const [key, ep] of currMap) { if (!prevMap.has(key)) changes.added.push(ep); }
  for (const [key, ep] of prevMap) { if (!currMap.has(key)) changes.removed.push(ep); }
  for (const [key, curr] of currMap) {
    const prev = prevMap.get(key);
    if (prev && (curr.parameters !== prev.parameters || curr.deprecated !== prev.deprecated)) changes.modified.push({ ...curr, previousParams: prev.parameters });
  }
  return changes;
}

function detectBreakingChanges(changes) {
  const breaking = [];
  for (const ep of changes.removed) breaking.push({ endpoint: `${ep.method} ${ep.path}`, type: 'removed', severity: 'breaking' });
  for (const ep of changes.modified) { if (ep.parameters < ep.previousParams) breaking.push({ endpoint: `${ep.method} ${ep.path}`, type: 'parameters_reduced', severity: 'potentially_breaking' }); }
  return breaking;
}

runSkill('api-evolution-manager', () => {
  const currentSpec = parseSpec(path.resolve(argv.current));
  const currentEndpoints = extractEndpoints(currentSpec);
  let changes = null, breaking = [];
  if (argv.previous) {
    const prevSpec = parseSpec(path.resolve(argv.previous));
    const prevEndpoints = extractEndpoints(prevSpec);
    changes = diffAPIs(currentEndpoints, prevEndpoints);
    breaking = detectBreakingChanges(changes);
  }
  const deprecated = currentEndpoints.filter(e => e.deprecated);
  const result = {
    source: path.basename(argv.current), endpointCount: currentEndpoints.length, endpoints: currentEndpoints,
    deprecated, deprecatedCount: deprecated.length,
    changes, breakingChanges: breaking, breakingCount: breaking.length,
    apiVersion: currentSpec.info?.version || currentSpec.openapi || 'unknown',
    recommendations: [
      ...breaking.map(b => `[${b.severity}] ${b.endpoint}: ${b.type}`),
      ...deprecated.map(d => `[deprecation] ${d.method} ${d.path} is deprecated - plan migration`),
    ],
  };
  if (argv.out) fs.writeFileSync(argv.out, JSON.stringify(result, null, 2));
  return result;
});
