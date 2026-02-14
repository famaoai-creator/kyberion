const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const filesToFix = [
  'browser-navigator/scripts/navigate.cjs',
  'security-scanner/scripts/scan.cjs',
  'voice-command-listener/scripts/listen.cjs',
  'layout-architect/scripts/extract_theme.cjs',
  'google-workspace-integrator/scripts/integrate.cjs'
];

filesToFix.forEach(relPath => {
  const absPath = path.join(rootDir, relPath);
  if (!fs.existsSync(absPath)) return;

  let content = fs.readFileSync(absPath, 'utf8');
  
  // 1. Import pathResolver if not present
  if (!content.includes('path-resolver.cjs')) {
    const importMatch = content.match(/const .* = require\(['"]path['"]\);/);
    if (importMatch) {
      const depth = relPath.split('/').length - 1;
      const prefix = '../'.repeat(depth);
      content = content.replace(importMatch[0], `${importMatch[0]}
const pathResolver = require('${prefix}scripts/lib/path-resolver.cjs');`);
    }
  }

  // 2. Replace hardcoded work paths
  // path.join(..., 'work/...') -> path.join(..., pathResolver.shared('...'))
  content = content.replace(/path\.join\((.*), ['"]work\/(.*)['"]\)/g, "path.join($1, pathResolver.shared('$2'))");
  // path.resolve(..., 'work/...') -> path.resolve(..., pathResolver.shared('...'))
  content = content.replace(/path\.resolve\((.*), ['"]work\/(.*)['"]\)/g, "path.resolve($1, pathResolver.shared('$2'))");
  // 'work/...' -> pathResolver.shared('...')
  content = content.replace(/['"]work\/(.*?)['"]/g, "pathResolver.shared('$1')");

  fs.writeFileSync(absPath, content);
  console.log(`[Fixed] ${relPath}`);
});
