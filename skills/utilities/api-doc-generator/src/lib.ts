import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeReadFileAsync } from '@agent/core/secure-io';

export interface ApiEndpoint {
  defined_in: string;
  source_of_truth: string;
}

export async function extractExpressRoutes(
  targetDir: string,
  patterns: any
): Promise<Record<string, ApiEndpoint>> {
  const apiSpecs: Record<string, ApiEndpoint> = {};
  const expressPattern = new RegExp(patterns.frameworks.express.route_regex, 'g');

  const files = fs
    .readdirSync(targetDir, { withFileTypes: true })
    .filter((e) => e.isFile() && (e.name.endsWith('.js') || e.name.endsWith('.cjs')))
    .map((e) => e.name);

  const tasks = files.map(async (file) => {
    const filePath = path.join(targetDir, file);
    const content = (await safeReadFileAsync(filePath)) as string;
    const matches = content.matchAll(expressPattern);

    for (const match of matches) {
      const method = match[patterns.frameworks.express.method_group].toUpperCase();
      const route = match[patterns.frameworks.express.path_group];
      apiSpecs[`${method} ${route}`] = {
        defined_in: file,
        source_of_truth: 'Reverse Engineered',
      };
    }
  });

  await Promise.all(tasks);
  return apiSpecs;
}
