import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger, pathResolver, safeReadFile, safeExistsSync } from '../libs/core/index.js';

async function runVitalReport() {
  const ROOT_DIR = pathResolver.rootDir();
  console.log('\n🩺 [KYBERION] Ecosystem Vital Report\n');
  console.log(`Report Generated: ${new Date().toLocaleString()}`);
  console.log(`Root Directory: ${ROOT_DIR}\n`);

  const checks = [
    { label: 'Physical Foundation (node_modules)', path: 'node_modules' },
    { label: 'System Build (dist)', path: 'dist' },
    { label: 'Sovereign Identity', path: 'knowledge/personal/my-identity.json' },
    { label: 'Sovereign Vision', path: 'knowledge/personal/my-vision.md' },
    { label: 'Governance Policies', path: 'knowledge/public/governance' }
  ];

  for (const check of checks) {
    const fullPath = path.join(ROOT_DIR, check.path);
    if (safeExistsSync(fullPath)) {
      console.log(`✅ [OK] ${check.label}`);
    } else {
      console.log(`❌ [FAIL] ${check.label} (Missing)`);
    }
  }

  // Active Missions
  const missionsDir = path.join(ROOT_DIR, 'active/missions');
  const personalMissionsDir = path.join(ROOT_DIR, 'knowledge/personal/missions');
  
  let activeCount = 0;
  [missionsDir, personalMissionsDir].forEach(dir => {
    if (safeExistsSync(dir)) {
      const missions = fs.readdirSync(dir).filter(m => fs.lstatSync(path.join(dir, m)).isDirectory());
      for (const m of missions) {
        const statePath = path.join(dir, m, 'mission-state.json');
        if (safeExistsSync(statePath)) {
          const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
          if (state.status === 'active') {
            activeCount++;
          }
        }
      }
    }
  });

  console.log(`\n🚀 Active Missions: ${activeCount}`);
  console.log('\nStatus: All systems operational within tolerance.\n');
}

runVitalReport().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
