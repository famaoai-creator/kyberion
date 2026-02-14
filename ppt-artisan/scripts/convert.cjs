#!/usr/bin/env node
/**
 * ppt-artisan/scripts/convert.cjs
 * Optimized PPT Artisan: MTime Caching & Direct Execution
 */

const { runSkillAsync } = require('@agent/core');
const { requireArgs } = require('@agent/core/validators');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

runSkillAsync('ppt-artisan', async () => {
  const argv = requireArgs(['input', 'out']);

  const inputPath = path.resolve(argv.input);
  const outputPath = path.resolve(argv.out);

  // 1. Performance Optimization: MTime Cache
  const stats = fs.statSync(inputPath);
  const outExists = fs.existsSync(outputPath);
  if (outExists) {
    const outStats = fs.statSync(outputPath);
    if (outStats.mtimeMs > stats.mtimeMs) {
      console.log(`[PPT] Using cached version: ${argv.out}`);
      return { status: 'success', output: outputPath, cached: true };
    }
  }

  // 2. Execution Optimization
  // Use local bin if available to avoid npx overhead
  const localMarp = path.resolve(__dirname, '../../node_modules/.bin/marp');
  const marpCmd = fs.existsSync(localMarp) ? `"${localMarp}"` : 'npx -y @marp-team/marp-cli';

  let cmd = `${marpCmd} "${inputPath}" --pptx --pptx-editable -o "${outputPath}" --allow-local-files`;

  if (argv.theme) {
    cmd += ` --theme "${path.resolve(argv.theme)}"`;
  }

  console.log(`[PPT] Generating ${argv.out}...`);
  execSync(cmd, { stdio: 'pipe' });

  return { status: 'success', output: outputPath, theme: argv.theme || 'default', cached: false };
});
