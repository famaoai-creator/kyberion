/**
 * scripts/ip_grep.ts
 * A lightweight scanner to identify potential IP/Patentable assets using regex.
 * Saves tokens by narrowing down search areas before AI analysis.
 * Usage: npx tsx scripts/ip_grep.ts [directory]
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';

const targetDir = process.argv[2] || '.';

// Essential IP Indicators (Simplified from former ip-strategist)
const INDICATORS = [
  { label: 'Algorithm', pattern: 'algorithm|heuristic|optimizer|inference|model' },
  { label: 'Protocol', pattern: 'protocol|handshake|negotiation|bridge' },
  { label: 'Security', pattern: 'cipher|encryption|decryption|pqc|quantum' }
];

console.log(`--- IP/Asset Grep Scan: [${targetDir}] ---`);

INDICATORS.forEach(ind => {
  try {
    const output = execSync(
      `grep -rEi "${ind.pattern}" ${targetDir} --include="*.ts" --include="*.js" --include="*.py" --exclude-dir="node_modules" --exclude-dir="dist" | head -n 20`,
      { encoding: 'utf8' }
    );
    if (output) {
      console.log(`\n[${ind.label}] matches:`);
      console.log(output.trim());
    }
  } catch (err) {
    // Grep returns exit code 1 if no matches found
  }
});
