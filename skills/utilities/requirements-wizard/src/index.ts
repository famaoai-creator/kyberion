import { runSkill, safeReadFile, safeWriteFile } from '@agent/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { requireArgs } from '@agent/core/validators';
import { auditRequirements } from './lib.js';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('requirements-wizard', () => {
    const argv = requireArgs(['input']);
    const inputPath = path.resolve(argv.input as string);
    const standardPath = argv.standard ? path.resolve(argv.standard as string) : null;

    if (!fs.existsSync(inputPath)) throw new Error(`Input not found: \${inputPath}`);

    const rawContent = safeReadFile(inputPath, { encoding: 'utf8' }) as string;
    let adf: any;
    try {
      adf = JSON.parse(rawContent);
    } catch (_e) {
      // Fallback for non-JSON (markdown/txt)
      adf = { content: rawContent, project_name: path.basename(inputPath) };
    }
    let checklist: string[] = [];

    if (standardPath && fs.existsSync(standardPath)) {
      const standardContent = safeReadFile(standardPath, { encoding: 'utf8' }) as string;
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
