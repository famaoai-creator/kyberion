import { compileFromFile } from 'json-schema-to-typescript';
import { pathResolver } from '@agent/core/path-resolver';
import { defineGenerator, isDirectScript, type GeneratedFile } from './lib/harness.js';

interface GenerationTarget {
  schemaPath: string;
  outputPath: string;
}

const targets: GenerationTarget[] = [
  {
    schemaPath: 'knowledge/product/schemas/wisdom-action.schema.json',
    outputPath: 'libs/core/contracts/wisdom-action.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/bridge-request.schema.json',
    outputPath: 'libs/core/contracts/bridge-request.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/diagram-adf.schema.json',
    outputPath: 'libs/core/contracts/diagram-adf.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/mission-contract.schema.json',
    outputPath: 'libs/core/contracts/mission-contract.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/skill-input.schema.json',
    outputPath: 'libs/core/contracts/skill-input.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/skill-output.schema.json',
    outputPath: 'libs/core/contracts/skill-output.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/architecture-adf.schema.json',
    outputPath: 'libs/core/contracts/architecture-adf.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/mobile-app-profile.schema.json',
    outputPath: 'libs/core/contracts/mobile-app-profile.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/mobile-app-profile-index.schema.json',
    outputPath: 'libs/core/contracts/mobile-app-profile-index.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/webview-session-handoff.schema.json',
    outputPath: 'libs/core/contracts/webview-session-handoff.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/web-app-profile.schema.json',
    outputPath: 'libs/core/contracts/web-app-profile.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/ui-flow-adf.schema.json',
    outputPath: 'libs/core/contracts/ui-flow-adf.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/test-case-adf.schema.json',
    outputPath: 'libs/core/contracts/test-case-adf.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/music-generation-adf.schema.json',
    outputPath: 'libs/core/contracts/music-generation-adf.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/image-generation-adf.schema.json',
    outputPath: 'libs/core/contracts/image-generation-adf.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/video-generation-adf.schema.json',
    outputPath: 'libs/core/contracts/video-generation-adf.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/generation-job.schema.json',
    outputPath: 'libs/core/contracts/generation-job.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/generation-schedule.schema.json',
    outputPath: 'libs/core/contracts/generation-schedule.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/proposal-brief.schema.json',
    outputPath: 'libs/core/contracts/proposal-brief.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/proposal-storyline-adf.schema.json',
    outputPath: 'libs/core/contracts/proposal-storyline-adf.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/corporate-design-adf.schema.json',
    outputPath: 'libs/core/contracts/corporate-design-adf.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/document-brief.schema.json',
    outputPath: 'libs/core/contracts/document-brief.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/actuator-execution-brief.schema.json',
    outputPath: 'libs/core/contracts/actuator-execution-brief.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/actuator-resolution-plan.schema.json',
    outputPath: 'libs/core/contracts/actuator-resolution-plan.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/delivery-pack.schema.json',
    outputPath: 'libs/core/contracts/delivery-pack.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/actuator-pipeline-bundle.schema.json',
    outputPath: 'libs/core/contracts/actuator-pipeline-bundle.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/system-status-brief.schema.json',
    outputPath: 'libs/core/contracts/system-status-brief.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/system-status-report.schema.json',
    outputPath: 'libs/core/contracts/system-status-report.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/operator-interaction-packet.schema.json',
    outputPath: 'libs/core/contracts/operator-interaction-packet.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/travel-planning-brief.schema.json',
    outputPath: 'libs/core/contracts/travel-planning-brief.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/booking-preference-profile.schema.json',
    outputPath: 'libs/core/contracts/booking-preference-profile.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/presentation-preference-profile.schema.json',
    outputPath: 'libs/core/contracts/presentation-preference-profile.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/slide-pattern-pack.schema.json',
    outputPath: 'libs/core/contracts/slide-pattern-pack.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/narrated-video-preference-profile.schema.json',
    outputPath: 'libs/core/contracts/narrated-video-preference-profile.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/narrated-video-publish-plan.schema.json',
    outputPath: 'libs/core/contracts/narrated-video-publish-plan.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/narrated-video-upload-package.schema.json',
    outputPath: 'libs/core/contracts/narrated-video-upload-package.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/meeting-operations-profile.schema.json',
    outputPath: 'libs/core/contracts/meeting-operations-profile.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/meeting-operations-brief.schema.json',
    outputPath: 'libs/core/contracts/meeting-operations-brief.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/points-portal-clickout-usecase.schema.json',
    outputPath: 'libs/core/contracts/points-portal-clickout-usecase.ts',
  },
];

async function render(): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = [];
  for (const target of targets) {
    const schemaPath = pathResolver.rootResolve(target.schemaPath);
    const outputPath = pathResolver.rootResolve(target.outputPath);
    const compiled = await compileFromFile(schemaPath, {
      bannerComment:
        '/* tslint:disable */\n' +
        '/* eslint-disable */\n' +
        '/**\n' +
        ' * This file was automatically generated by json-schema-to-typescript.\n' +
        ' * DO NOT MODIFY IT BY HAND. Instead, modify the source JSONSchema file,\n' +
        ' * and run `pnpm generate:types` to regenerate this file.\n' +
        ' */',
      style: {
        semi: true,
        singleQuote: true,
      },
    });
    files.push({ path: outputPath, content: compiled });
  }
  return files;
}

export const runGenerateTypes = defineGenerator({
  id: 'types',
  outputs: targets.map((target) => pathResolver.rootResolve(target.outputPath)),
  render,
});

if (
  isDirectScript(import.meta.url, 'generate_types.ts') ||
  isDirectScript(import.meta.url, 'generate_types.js')
)
  void runGenerateTypes();
