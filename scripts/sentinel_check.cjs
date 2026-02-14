/**
 * Sentinel Check Utility
 * Autonomously bundles security, quality, and documentation drift checks.
 */
const { execSync } = require('child_process');
const fs = require('fs');

console.log('--- Sentinel Analysis Starting ---');

const checks = [
  { name: 'Security', cmd: 'node scripts/cli.cjs run security-scanner -- --dir .' },
  { name: 'Health', cmd: 'node scripts/cli.cjs run project-health-check -- --dir .' },
  {
    name: 'Stale TODOs',
    cmd: 'grep -rE "TODO|FIXME" . --exclude-dir={node_modules,.git} | head -n 5',
  },
];

const results = {};

checks.forEach((check) => {
  try {
    console.log(`[Sentinel] Running ${check.name}...`);
    const output = execSync(check.cmd).toString();
    results[check.name] = output;
  } catch (e) {
    results[check.name] = `Failed: ${e.message}`;
  }
});

fs.writeFileSync('work/sentinel-report.json', JSON.stringify(results, null, 2));
console.log('--- Sentinel Analysis Complete. Report saved to work/sentinel-report.json ---');
