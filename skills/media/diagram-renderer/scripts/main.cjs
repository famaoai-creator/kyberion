#!/usr/bin/env node
/**
 * diagram-renderer/scripts/main.cjs
 * Universal Visual Engine - Protocol v1.1 Implementation.
 * Uses 'intent' for semantics and 'engine' for physical rendering.
 */

const path = require('path');
const { execSync } = require('child_process');
const { runSkill } = require('@agent/core');
const { safeWriteFile, safeReadFile, safeUnlinkSync } = require('@agent/core/secure-io');
const { requireArgs } = require('@agent/core/validators');

function loadKnowledge() {
  const rootDir = process.cwd();
  const getPath = (f) => path.resolve(rootDir, `knowledge/skills/diagram-renderer/${f}`);
  return {
    registry: JSON.parse(safeReadFile(getPath('theme-registry.json'), 'utf8')),
    rules: JSON.parse(safeReadFile(getPath('design-rules.json'), 'utf8')).rules,
    styles: JSON.parse(safeReadFile(getPath('design-styles.json'), 'utf8')).styles,
    icons: JSON.parse(safeReadFile(path.resolve(rootDir, 'knowledge/skills/diagram-renderer/icon-map.json'), 'utf8'))
  };
}

function applyDesignerStyle(mmd, adf, knowledge) {
  const themeKey = adf.theme || 'base';
  const themeConfig = knowledge.registry.themes[themeKey] || knowledge.registry.themes.base;
  const overrides = adf.overrides || {};
  const styleRule = themeKey === 'dark' ? knowledge.styles.tech_dark : knowledge.styles.professional_base;
  const init = {
    theme: themeConfig.theme,
    themeVariables: { ...themeConfig.variables, ...(overrides.theme_variables || {}) },
    flowchart: { ...themeConfig.flowchart },
    gantt: { ...themeConfig.gantt },
    cssStyles: `${styleRule ? Object.values(styleRule).join(' ') : ''} ${overrides.custom_style || ''}`
  };
  return `%%{init: ${JSON.stringify(init)} }%%\n${mmd}`;
}

function delegateHtml(adf, out) {
  const scenario = `name: 'UI Render'\nsteps:\n  - action: 'goto'\n    url: 'file://${path.resolve(process.cwd(), adf.elements.html_path)}'\n  - action: '${out.endsWith('.svg') ? 'screenshot_svg' : 'screenshot'}'\n    save_path: '${out}'`;
  const sPath = path.join(path.dirname(out), 'render.yaml');
  safeWriteFile(sPath, scenario);
  try { execSync(`node scripts/cli.cjs run browser-navigator --scenario "${sPath}"`, { stdio: 'inherit', cwd: process.cwd() }); }
  finally { 
    try { safeUnlinkSync(sPath); } catch (_) {}
  }
}

function renderSalt(mmd, out) {
  const p = out.replace(/\.[^.]+$/, '.puml');
  safeWriteFile(p, mmd);
  try {
    execSync(`plantuml -tsvg "${p}"`, { stdio: 'inherit' });
    const svgPath = p.replace('.puml', '.svg');
    try {
      const svg = safeReadFile(svgPath);
      if (svg) {
        safeWriteFile(out, svg);
        safeUnlinkSync(svgPath);
      }
    } catch (_) {}
  } catch (e) { throw new Error(`Salt failed: ${e.message}`); }
}

function renderD2(mmd, out) {
  const p = out.replace(/\.[^.]+$/, '.d2');
  safeWriteFile(p, mmd);
  try { execSync(`d2 "${p}" "${out}"`, { stdio: 'inherit' }); }
  catch (e) { throw new Error(`D2 failed: ${e.message}`); }
}

runSkill('diagram-renderer', async () => {
  const argv = requireArgs(['input', 'out']);
  const inputPath = path.resolve(argv.input);
  const outputPath = path.resolve(argv.out);
  const adf = JSON.parse(safeReadFile(inputPath, 'utf8'));
  if (adf.protocol !== 'gemini-diagram-v1') throw new Error('Unsupported protocol.');

  const knowledge = loadKnowledge();
  const rule = knowledge.rules[adf.intent] || {};
  const mergedAdf = { ...rule, ...adf };

  const engine = adf.engine || rule.type || 'mermaid'; // Rule fallback
  const diagramContent = (adf.elements.diagram || '').replace(/\\n/g, '\n');

  switch (engine) {
    case 'html': delegateHtml(mergedAdf, outputPath); break;
    case 'salt': renderSalt(diagramContent, outputPath); break;
    case 'd2':   renderD2(diagramContent, outputPath); break;
    default:
      const mmdPath = outputPath.replace(/\.[^.]+$/, '.mmd');
      const mmdContent = applyDesignerStyle(diagramContent, mergedAdf, knowledge);
      safeWriteFile(mmdPath, mmdContent);
      execSync(`npx -y @mermaid-js/mermaid-cli -i "${mmdPath}" -o "${outputPath}"`, { stdio: 'inherit' });
  }
  return { status: 'success', engine, finalArtifact: outputPath };
});
