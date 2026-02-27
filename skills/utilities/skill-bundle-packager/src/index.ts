import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import * as pathResolver from '@agent/core/path-resolver';
import { findPlaybook } from './lib.js';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('skill-bundle-packager', () => {
    const missionName = process.argv[2];
    const selectedSkills = process.argv.slice(3);

    if (!missionName) throw new Error('Mission name required');

    const rootDir = pathResolver.rootDir();
    const bundleDir = path.join(pathResolver.shared('bundles'), missionName);
    const manifestFile = path.join(bundleDir, 'bundle.json');

    if (!fs.existsSync(bundleDir)) fs.mkdirSync(bundleDir, { recursive: true });

    const playbook = findPlaybook(missionName, rootDir);
    const bundle = {
      mission: missionName,
      created_at: new Date().toISOString(),
      skills: selectedSkills.map((name) => ({ name, path: './' + name + '/' })),
      playbook: playbook ? playbook.path : null,
    };

    fs.writeFileSync(manifestFile, JSON.stringify(bundle, null, 2));

    return { mission: missionName, manifest: manifestFile };
  });
}
