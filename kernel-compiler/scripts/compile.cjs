#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const { execSync } = require('child_process');
 const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { walk, getAllFiles } = require('../../scripts/lib/fs-utils.cjs');
const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Project directory' })
  .option('target', { alias: 't', type: 'string', default: 'node', choices: ['node', 'go', 'rust', 'docker'], description: 'Compilation target' })
  .option('dry-run', { type: 'boolean', default: true, description: 'Analyze without compiling' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

function analyzeProject(dir) {
  const analysis = { entryPoints: [], dependencies: 0, scripts: [], languages: {} };
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.main) analysis.entryPoints.push(pkg.main);
    if (pkg.bin) { const bins = typeof pkg.bin === 'string' ? { default: pkg.bin } : pkg.bin; analysis.entryPoints.push(...Object.values(bins)); }
    analysis.dependencies = Object.keys(pkg.dependencies || {}).length;
    analysis.scripts = Object.keys(pkg.scripts || {});
  }
  function walk(d, depth) {
    if (depth > 3) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        if (e.isDirectory()) { walk(path.join(d, e.name), depth + 1); continue; }
        const ext = path.extname(e.name);
        if (['.js','.cjs','.ts','.go','.rs','.py'].includes(ext)) analysis.languages[ext] = (analysis.languages[ext] || 0) + 1;
      }
    } catch(_e){}
  }
  walk(dir, 0);
  return analysis;
}

function generateBuildPlan(analysis, target) {
  const plans = {
    node: { tool: 'pkg or nexe', command: `npx pkg ${analysis.entryPoints[0] || 'index.js'} --targets node18-linux-x64,node18-macos-x64,node18-win-x64`, output: 'dist/', prerequisites: ['npm install --production'] },
    go: { tool: 'Go compiler', command: 'GOOS=linux GOARCH=amd64 go build -o dist/app .', output: 'dist/app', prerequisites: ['go mod tidy'] },
    rust: { tool: 'Cargo', command: 'cargo build --release --target x86_64-unknown-linux-gnu', output: 'target/release/', prerequisites: ['cargo check'] },
    docker: { tool: 'Docker', command: `docker build -t app:latest .`, output: 'Docker image', prerequisites: ['Dockerfile must exist'] },
  };
  return plans[target];
}

function checkToolchain(target) {
  const checks = {};
  try {
    if (target === 'node') { checks.node = execSync('node --version', { encoding: 'utf8' }).trim(); checks.npm = execSync('npm --version', { encoding: 'utf8' }).trim(); }
    if (target === 'go') { try { checks.go = execSync('go version', { encoding: 'utf8' }).trim(); } catch(_e) { checks.go = 'not installed'; } }
    if (target === 'rust') { try { checks.rust = execSync('rustc --version', { encoding: 'utf8' }).trim(); } catch(_e) { checks.rust = 'not installed'; } }
    if (target === 'docker') { try { checks.docker = execSync('docker --version', { encoding: 'utf8' }).trim(); } catch(_e) { checks.docker = 'not installed'; } }
  } catch(_e){}
  return checks;
}

runSkill('kernel-compiler', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);
  const analysis = analyzeProject(targetDir);
  const buildPlan = generateBuildPlan(analysis, argv.target);
  const toolchain = checkToolchain(argv.target);
  const result = {
    directory: targetDir, target: argv.target, mode: argv['dry-run'] ? 'dry-run' : 'compile',
    projectAnalysis: analysis, buildPlan, toolchain,
    recommendations: [
      analysis.entryPoints.length === 0 ? '[warn] No entry point found - specify in package.json "main" or "bin"' : `Entry: ${analysis.entryPoints[0]}`,
      `Dependencies: ${analysis.dependencies} (will be bundled)`,
    ],
  };
  if (argv.out) fs.writeFileSync(argv.out, JSON.stringify(result, null, 2));
  return result;
});
