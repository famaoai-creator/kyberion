const fs = require('fs');
const path = require('path');
const { logger, fileUtils } = require('../../scripts/lib/core.cjs');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');

/**
 * Skill Bundle Packager
 * Creates a manifest of selected skills for a specific mission.
 */

const missionName = process.argv[2];
const selectedSkills = process.argv.slice(3);

if (!missionName || selectedSkills.length === 0) {
  logger.error('Usage: node bundle.cjs <mission-name> <skill-1> <skill-2> ...');
  process.exit(1);
}

const rootDir = path.resolve(__dirname, '../../');
const bundleDir = path.join(rootDir, 'work/bundles', missionName);
const manifestFile = path.join(bundleDir, 'bundle.json');

// Find matching playbook for this mission
function findPlaybook(mission) {
  const playbooksDir = path.join(rootDir, 'knowledge/orchestration/mission-playbooks');
  if (!fs.existsSync(playbooksDir)) return null;
  try {
    const files = fs.readdirSync(playbooksDir).filter((f) => f.endsWith('.md'));
    // Try to match mission name to playbook
    const missionLower = mission.toLowerCase();
    for (const file of files) {
      const name = file.replace('.md', '').toLowerCase();
      if (missionLower.includes(name) || name.includes(missionLower.replace('-starter', ''))) {
        return {
          path: `knowledge/orchestration/mission-playbooks/${file}`,
          guidance: `See victory conditions in the playbook. Use with Gemini: 'Execute the ${file.replace('.md', '')} playbook'`,
        };
      }
    }
  } catch (_e) {
    /* ignore */
  }
  return null;
}

runSkill('skill-bundle-packager', () => {
  fileUtils.ensureDir(bundleDir);

  const playbook = findPlaybook(missionName);

  const bundle = {
    mission: missionName,
    created_at: new Date().toISOString(),
    skills: selectedSkills
      .map((name) => {
        const skillPath = path.join(rootDir, name);
        if (!fs.existsSync(skillPath)) {
          logger.warn(`Skill not found: ${name}`);
          return null;
        }
        return { name, path: `./${name}/` };
      })
      .filter((s) => s !== null),
  };

  if (playbook) {
    bundle.playbook = playbook.path;
    bundle.guidance = playbook.guidance;
  }

  fileUtils.writeJson(manifestFile, bundle);

  return {
    mission: missionName,
    manifest: manifestFile,
    skillCount: bundle.skills.length,
    playbook: playbook ? playbook.path : null,
  };
});
