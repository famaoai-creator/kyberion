/**
 * scripts/gen_test_cases.ts
 * Generates initial test case IDs and scenarios from requirement ADF (JSON).
 * Usage: npx tsx scripts/gen_test_cases.ts [requirement.json]
 */
import * as fs from 'node:fs';

const reqPath = process.argv[2];

console.log('--- Test Case Generation ---');

if (!reqPath || !fs.existsSync(reqPath)) {
  console.log('No requirement file provided. Usage: npx tsx scripts/gen_test_cases.ts <requirement.json>');
  process.exit(0);
}

try {
  const adf = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
  const reqs = adf.requirements || [];

  console.log(`\n[Generated Cases for: ${adf.title || 'Untitled'}]:`);
  reqs.forEach((req: any) => {
    console.log(`\n- [${req.id}] ${req.title}`);
    console.log(`  [Normal]   TC-${req.id}-01: Valid application`);
    
    const rule = (req.rule || '').toLowerCase();
    if (rule.includes('threshold') || rule.includes('$') || rule.includes('%')) {
      console.log(`  [Boundary] TC-${req.id}-02: Exact threshold handling`);
    }
  });

} catch (err) {
  console.error('Failed to process requirement JSON');
}
