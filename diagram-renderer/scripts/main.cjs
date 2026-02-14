#!/usr/bin/env node
/**
 * diagram-renderer/scripts/main.cjs
 * Pure Logic Renderer - Loads icons from knowledge base.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runSkill } = require('@agent/core');
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const { requireArgs } = require('@agent/core/validators');

/**
 * Transforms Gemini ADF into Mermaid Flowchart syntax.
 */
function adfToMermaid(adf, iconMap) {
  let mmd = `graph LR\n`;

  adf.nodes.forEach((node) => {
    const id = node.id.replace(/[\.\-]/g, '_');
    const icon = iconMap[node.type] || iconMap.default;
    const label = `"${icon} ${node.name}"`;
    mmd += `    ${id}(${label})\n`;
  });

  adf.edges.forEach((edge) => {
    const from = edge.from.replace(/[\.\-]/g, '_');
    const to = edge.to.replace(/[\.\-]/g, '_');
    const label = edge.label ? `|"${edge.label}"|` : '';
    mmd += `    ${from} -->${label} ${to}\n`;
  });

  return mmd;
}

runSkill('diagram-renderer', () => {
  const argv = requireArgs(['input', 'out']);
  const inputPath = path.resolve(argv.input);
  const outputPath = path.resolve(argv.out);
  const mmdPath = outputPath.replace(/\.[^.]+$/, '.mmd');

  // 1. Load Data
  if (!fs.existsSync(inputPath)) throw new Error(`Input not found: ${inputPath}`);
  const adf = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

  // 2. Load Icon Knowledge (Externalized)
  const iconMapPath = path.resolve(
    __dirname,
    '../../knowledge/skills/diagram-renderer/icon-map.json'
  );
  if (!fs.existsSync(iconMapPath)) throw new Error(`Icon map knowledge missing: ${iconMapPath}`);
  const iconMap = JSON.parse(fs.readFileSync(iconMapPath, 'utf8'));

  // 3. Generate Mermaid Text
  const mmdContent = adfToMermaid(adf, iconMap);
  safeWriteFile(mmdPath, mmdContent);

  // 4. Render SVG
  try {
    execSync(`npx -y @mermaid-js/mermaid-cli -i "${mmdPath}" -o "${outputPath}"`, {
      stdio: 'inherit',
    });
  } catch (err) {
    throw new Error(`Rendering failed: ${err.message}`);
  }

  return { status: 'success', intermediateArtifact: mmdPath, finalArtifact: outputPath };
});
