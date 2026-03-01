import * as path from 'node:path';
import { runSkillAsync } from '@agent/core';
import { requireArgs } from '@agent/core/validators';
import { safeWriteFile, safeReadFileAsync } from '@agent/core/secure-io';
import { extractExpressRoutes } from './lib.js';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkillAsync('api-doc-generator', async () => {
    const argv = requireArgs(['dir', 'out']);
    const targetDir = path.resolve(argv.dir as string);
    const outputPath = path.resolve(argv.out as string);

    const patternsPath = path.resolve(
      process.cwd(),
      'knowledge/skills/api-doc-generator/patterns.json'
    );
    const patterns = JSON.parse((await safeReadFileAsync(patternsPath)) as string);

    const apiSpecs = await extractExpressRoutes(targetDir, patterns);

    const adf = {
      title: 'Substantive API Specification',
      generated_at: new Date().toISOString(),
      endpoints: apiSpecs,
    };

    safeWriteFile(outputPath, JSON.stringify(adf, null, 2));

    return {
      status: 'success',
      extracted_endpoints: Object.keys(apiSpecs).length,
      output: outputPath,
    };
  });
}
