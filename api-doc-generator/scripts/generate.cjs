#!/usr/bin/env node
/**
 * api-doc-generator/scripts/generate.cjs
 * High-Performance Engine: Parallel Extraction & MTime Caching
 */

const fs = require('fs');
const path = require('path');
const { runSkillAsync } = require('@agent/core');
const { requireArgs } = require('@agent/core/validators');
const { safeWriteFile, safeReadFileAsync } = require('@agent/core/secure-io');

runSkillAsync('api-doc-generator', async () => {
  const argv = requireArgs(['dir', 'out']);
  const targetDir = path.resolve(argv.dir);
  const outputPath = path.resolve(argv.out);

  // 1. Load Knowledge (Externalized Patterns)
  const patternsPath = path.resolve(
    __dirname,
    '../../knowledge/skills/api-doc-generator/patterns.json'
  );
  const { frameworks } = JSON.parse(await safeReadFileAsync(patternsPath));
  const expressPattern = new RegExp(frameworks.express.route_regex, 'g');

  const apiSpecs = {};
  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && (e.name.endsWith('.js') || e.name.endsWith('.cjs')))
    .map((e) => e.name);

  // 2. Parallel Extraction with Global Cache
  const extractionTasks = files.map(async (file) => {
    const filePath = path.join(targetDir, file);

    // safeReadFileAsync handles caching and timeouts internally
    const content = await safeReadFileAsync(filePath);
    const matches = content.matchAll(expressPattern);

    for (const match of matches) {
      const method = match[frameworks.express.method_group].toUpperCase();
      const route = match[frameworks.express.path_group];

      // Note: simple assignment is not thread-safe if multiple files define same route,
      // but for docs generation last-write-wins is acceptable or we can use a lock if needed.
      apiSpecs[`${method} ${route}`] = {
        defined_in: file,
        source_of_truth: 'Reverse Engineered via SCAP/RDP/Parallel',
      };
    }
  });

  await Promise.all(extractionTasks);

  // 4. Output as Source of Truth (Text-First)
  const adf = {
    title: 'Substantive API Specification',
    generated_at: new Date().toISOString(),
    endpoints: apiSpecs,
  };

  safeWriteFile(outputPath, JSON.stringify(adf, null, 2));

  return {
    status: 'success',
    processed_files: files.length,
    extracted_endpoints: Object.keys(apiSpecs).length,
    output: outputPath,
  };
});
