const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const doctorCore = require('./lib/doctor_core.cjs');

console.log('=== 🏥 Gemini Skills Ecosystem: Global Doctor ===\n');

// 1. 全システム共通の基盤チェック
doctorCore.checkAccessibility();
doctorCore.checkCommand('node', 'Node.js');
doctorCore.checkCommand('npm', 'npm');
doctorCore.checkKnowledgeTiers(rootDir);
doctorCore.checkOperationalMemory(rootDir);

console.log('--------------------------------------------------');

// 2. 各スキルのスキャン
const items = fs.readdirSync(rootDir, { withFileTypes: true });
const skillDirs = items.filter(
  (item) =>
    item.isDirectory() &&
    !item.name.startsWith('.') &&
    !['node_modules', 'scripts', 'knowledge', 'work', 'dist', 'coverage', 'evidence'].includes(
      item.name
    )
);

let total = 0;
let withDoctor = 0;

skillDirs.forEach((dir) => {
  total++;
  const doctorPath = path.join(rootDir, dir.name, 'scripts', 'doctor.cjs');

  if (fs.existsSync(doctorPath)) {
    withDoctor++;
    console.log(`\n[${dir.name}]`);
    try {
      execSync(`node ${doctorPath}`, { stdio: 'inherit' });
    } catch (_e) {
      console.log(`   ❌ Diagnosis failed`);
    }
  }
});

console.log('\n--------------------------------------------------');
console.log(`Scan Complete: ${total} skills found.`);
console.log(`Health-check enabled skills: ${withDoctor}/${total}`);
console.log('--------------------------------------------------');
