#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const activeMissionsDir = path.join(rootDir, 'active/missions');
const evidenceMissionsDir = path.join(rootDir, 'evidence/missions');

if (!fs.existsSync(activeMissionsDir)) {
  console.log('No active missions directory found.');
  process.exit(0);
}

const missions = fs
  .readdirSync(activeMissionsDir)
  .filter((f) => fs.lstatSync(path.join(activeMissionsDir, f)).isDirectory());

let archivedCount = 0;

for (const mission of missions) {
  const missionDir = path.join(activeMissionsDir, mission);
  const reportPath = path.join(missionDir, 'ace-report.json');

  if (fs.existsSync(reportPath)) {
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      const timestamp = report.timestamp || new Date().toISOString();
      const date = new Date(timestamp);
      const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

      const targetDir = path.join(evidenceMissionsDir, yearMonth, mission);

      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      // Move entire mission directory to evidence
      fs.cpSync(missionDir, targetDir, { recursive: true });
      fs.rmSync(missionDir, { recursive: true, force: true });

      console.log(`[SUCCESS] Archived mission ${mission} to ${yearMonth}`);
      archivedCount++;
    } catch (err) {
      console.error(`[ERROR] Failed to archive mission ${mission}: ${err.message}`);
    }
  } else {
    // If no report, check modified time. If older than 7 days, move to orphaned.
    const stat = fs.statSync(missionDir);
    const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
    if (ageDays > 7) {
      const targetDir = path.join(evidenceMissionsDir, 'orphaned', mission);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      fs.cpSync(missionDir, targetDir, { recursive: true });
      fs.rmSync(missionDir, { recursive: true, force: true });
      console.log(`[INFO] Archived orphaned mission ${mission} (No ace-report.json)`);
      archivedCount++;
    }
  }
}

if (archivedCount === 0) {
  console.log('No missions needed archiving.');
} else {
  console.log(`[SUCCESS] Successfully archived ${archivedCount} missions.`);
}
