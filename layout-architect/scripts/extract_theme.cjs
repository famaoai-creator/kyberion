#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runSkillAsync } = require('@agent/core');
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true })
  .option('name', { alias: 'n', type: 'string', default: 'learned-theme' }).argv;

runSkillAsync('layout-architect', async () => {
  const inputPath = path.resolve(argv.input);
  const themeName = argv.name;

  if (!fs.existsSync(inputPath)) throw new Error(`Input not found: ${inputPath}`);

  const tmpDir = path.join(process.cwd(), 'work/ppt-train/tmp');
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  console.log(`[Learner] Decompiling ${argv.input}...`);
  execSync(`unzip -o "${inputPath}" -d "${tmpDir}"`);

  const themeXmlPath = path.join(tmpDir, 'ppt/theme/theme1.xml');
  let bgColor = '#ffffff';
  let textColor = '#333333';
  let accentColor = '#3498db';

  if (fs.existsSync(themeXmlPath)) {
    const xml = fs.readFileSync(themeXmlPath, 'utf8');
    const dk1 = xml.match(/<a:dk1>.*?<a:srgbClr val="([A-F0-9]+)"/s);
    const lt1 = xml.match(/<a:lt1>.*?<a:srgbClr val="([A-F0-9]+)"/s);
    const accent1 = xml.match(/<a:accent1>.*?<a:srgbClr val="([A-F0-9]+)"/s);

    if (dk1) textColor = `#${dk1[1].toLowerCase()}`;
    if (lt1) bgColor = `#${lt1[1].toLowerCase()}`;
    if (accent1) accentColor = `#${accent1[1].toLowerCase()}`;
  }

  const css = `/* @theme ${themeName} */\n@import 'default';\nsection { background-color: ${bgColor}; color: ${textColor}; padding: 50px; }\nh1 { color: ${accentColor}; border-bottom: 2px solid ${accentColor}; }\nfooter { color: ${accentColor}; }`;

  const outputPath = path.resolve(__dirname, `../../knowledge/templates/themes/${themeName}.css`);
  safeWriteFile(outputPath, css);
  fs.rmSync(tmpDir, { recursive: true });

  return { status: 'learned', themePath: outputPath };
});
