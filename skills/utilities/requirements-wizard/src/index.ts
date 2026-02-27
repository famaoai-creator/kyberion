import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { requireArgs } from '@agent/core/validators';
import { auditRequirements } from './lib.js';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('requirements-wizard', () => {
    const argv = requireArgs(['input']);
    const inputPath = path.resolve(argv.input as string);
    const standardPath = argv.standard ? path.resolve(argv.standard as string) : null;

    if (!fs.existsSync(inputPath)) throw new Error(`Input not found: \${inputPath}`);

    const adf = JSON.parse(safeReadFile(inputPath, 'utf8'));
    let checklist: string[] = [];

    if (standardPath && fs.existsSync(standardPath)) {
      const standardContent = safeReadFile(standardPath, 'utf8');
      const matches = standardContent.matchAll(/^###?\s+(.+)$/gm);
      for (const match of matches) {
        checklist.push(match[1].trim());
      }
    } else {
      checklist = ['availability', 'performance', 'security', 'scalability', 'usability'];
    }

    const { score, results } = auditRequirements(adf, checklist);

    return {
      project: adf.project_name || 'Unknown',
      score,
      audit_results: results,
      standard_used: standardPath || 'default-lite',
    };
  });
}
