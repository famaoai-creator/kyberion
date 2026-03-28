import { logger, pathResolver, safeExistsSync, safeMkdir, safeReadFile } from '@agent/core';
import * as path from 'node:path';
import { handleAction } from '../libs/actuators/media-actuator/src/index.js';

interface TemplateSpec {
  pattern_id: string;
  title: string;
  pattern_path: string;
  theme: string;
  output: string;
}

interface TemplateLibrary {
  library_id: string;
  templates: TemplateSpec[];
}

async function generateTemplate(template: TemplateSpec) {
  const outputDir = path.dirname(pathResolver.rootResolve(template.output));
  if (!safeExistsSync(outputDir)) {
    safeMkdir(outputDir, { recursive: true });
  }

  logger.info(`Generating ${template.pattern_id} -> ${template.output}`);
  const result = await handleAction({
    action: 'pipeline',
    steps: [
      {
        type: 'transform',
        op: 'apply_theme',
        params: { theme: template.theme },
      },
      {
        type: 'transform',
        op: 'apply_pattern',
        params: { pattern_path: template.pattern_path },
      },
      {
        type: 'transform',
        op: 'merge_content',
        params: { output_format: 'pptx' },
      },
      {
        type: 'apply',
        op: 'pptx_render',
        params: { path: template.output },
      },
    ],
  });

  const failed = result.results.filter((r: any) => r.status === 'failed');
  if (failed.length > 0) {
    throw new Error(`${template.pattern_id}: ${failed.map((f: any) => f.error).join(', ')}`);
  }
}

async function main() {
  const manifestPath = pathResolver.rootResolve('knowledge/public/design-patterns/presentation/pptx-template-library.json');
  const manifest = JSON.parse(
    safeReadFile(manifestPath, { encoding: 'utf8' }) as string
  ) as TemplateLibrary;

  logger.info(`Template library: ${manifest.library_id}`);
  for (const template of manifest.templates) {
    await generateTemplate(template);
  }
  logger.info(`Generated ${manifest.templates.length} PPTX templates.`);
}

main().catch((err) => {
  logger.error(err.message);
  process.exit(1);
});
