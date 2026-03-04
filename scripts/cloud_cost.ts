/**
 * scripts/cloud_cost.ts
 * Estimates cloud costs from a simple resource definition (JSON).
 * Usage: npx tsx scripts/cloud_cost.ts [resources.json]
 */
import * as fs from 'node:fs';

const resPath = process.argv[2];

const UNIT_PRICES: Record<string, Record<string, number>> = {
  compute: { small: 15, medium: 45, large: 120, xlarge: 300 },
  database: { small: 30, medium: 90, large: 240, xlarge: 600 },
  storage: { small: 5, medium: 20, large: 100, xlarge: 250 },
  serverless: { small: 2, medium: 10, large: 50, xlarge: 100 },
};

console.log('--- Cloud Cost Estimation ---');

if (!resPath || !fs.existsSync(resPath)) {
  console.log('No resource file provided. Usage: npx tsx scripts/cloud_cost.ts <resources.json>');
  process.exit(0);
}

try {
  const resources = JSON.parse(fs.readFileSync(resPath, 'utf8'));
  let totalMonthly = 0;

  console.log('\n[Resource Breakdown]:');
  resources.forEach((r: any) => {
    const cost = (UNIT_PRICES[r.type]?.[r.size] || 10) * (r.count || 1);
    totalMonthly += cost;
    console.log(`- ${r.name} (${r.type}/${r.size}) x${r.count || 1}: $${cost}/mo`);
  });

  console.log('\n--- Total ---');
  console.log(`Monthly: $${totalMonthly}`);
  console.log(`Yearly:  $${totalMonthly * 12}`);

} catch (err) {
  console.error('Failed to process resources JSON');
}
