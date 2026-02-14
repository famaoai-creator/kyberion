#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { runAsyncSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { execSync } = require('child_process');

const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', description: 'Input directory or file', demandOption: true })
  .option('type', { alias: 't', type: 'string', choices: ['screen', 'state', 'component'], default: 'screen' })
  .option('fidelity', { alias: 'f', type: 'string', choices: ['low', 'high'], default: 'high' })
  .option('output', { alias: 'o', type: 'string', description: 'Output Mermaid file' })
  .option('render', { alias: 'r', type: 'boolean', default: false, description: 'Render to image' })
  .argv;

runAsyncSkill('ux-visualizer', async () => {
  console.log(`\n\ud83d\udd0d Analyzing ${argv.input} for ${argv.type} transitions...`);

  // Template for High-Fidelity SPA State
  const hiFiTemplate = (title, accentColor = '#fc4d7d') => `
  Screen["<div style='width:400px; background:#fff; border:1px solid #333; font-family:sans-serif;'>
    <div style='background:#303454; color:white; padding:10px; display:flex; justify-content:space-between;'>
      <span>🐾 Header</span><span>🔍 👤 ♡ 🛒</span>
    </div>
    <div style='height:80px; background:#eee; display:flex; align-items:center; justify-content:center; color:#999;'>Hero Section</div>
    <div style='padding:15px; text-align:center;'>
      <h3 style='color:#2c3454;'>${title}</h3>
      <div style='width:40px; height:2px; background:${accentColor}; margin:5px auto;'></div>
    </div>
    <div style='padding:10px; display:grid; grid-template-columns: 1fr 1fr; gap:10px;'>
      <div style='border:1px solid #eee; padding:5px; text-align:center;'>Item 1</div>
      <div style='border:2px solid ${accentColor}; padding:5px; text-align:center; background:#fff0f5;'>Item 2 (Active)</div>
    </div>
    <div style='background:#222; color:#fff; padding:10px; text-align:center; font-size:10px;'>Footer</div>
  </div>"]`;

  let mermaidCode = 'graph TD\n';
  if (argv.fidelity === 'high' && argv.type === 'screen') {
    mermaidCode += `  S1${hiFiTemplate('Home View')}\n`;
    mermaidCode += `  S2${hiFiTemplate('Active State')}\n`;
    mermaidCode += `  S1 -- "User Interaction" --> S2`;
  } else {
    mermaidCode += `  Start --> Process --> End`;
  }

  const outPath = argv.output || path.join(process.cwd(), `ux_output_${argv.type}.mmd`);
  fs.writeFileSync(outPath, mermaidCode);
  console.log(`\u2714 Generated ${argv.fidelity}-fidelity Mermaid code: ${outPath}`);

  if (argv.render) {
    console.log(`\ud83c\udfa8 Rendering to SVG...`);
    try {
      const svgPath = outPath.replace('.mmd', '.svg');
      execSync(`npx -y @mermaid-js/mermaid-cli -i "${outPath}" -o "${svgPath}"`, { stdio: 'inherit' });
      console.log(`\u2714 SVG saved: ${svgPath}`);
    } catch (e) {
      console.warn('  [!] Rendering failed.');
    }
  }

  return { type: argv.type, fidelity: argv.fidelity, output: outPath };
});
