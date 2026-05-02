import { compileFromFile } from 'json-schema-to-typescript';
import { pathResolver } from '@agent/core';
import { safeWriteFile } from '@agent/core/secure-io';

interface GenerationTarget {
  schemaPath: string;
  outputPath: string;
}

const targets: GenerationTarget[] = [
  {
    schemaPath: 'schemas/bridge-request.schema.json',
    outputPath: 'libs/core/src/types/bridge-request.ts',
  },
  {
    schemaPath: 'schemas/diagram-adf.schema.json',
    outputPath: 'libs/core/src/types/diagram-adf.ts',
  },
  {
    schemaPath: 'schemas/mission-contract.schema.json',
    outputPath: 'libs/core/src/types/mission-contract.ts',
  },
  {
    schemaPath: 'schemas/skill-input.schema.json',
    outputPath: 'libs/core/src/types/skill-input.ts',
  },
  {
    schemaPath: 'schemas/skill-output.schema.json',
    outputPath: 'libs/core/src/types/skill-output.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/architecture-adf.schema.json',
    outputPath: 'libs/core/src/types/architecture-adf.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/mobile-app-profile.schema.json',
    outputPath: 'libs/core/src/types/mobile-app-profile.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/mobile-app-profile-index.schema.json',
    outputPath: 'libs/core/src/types/mobile-app-profile-index.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/webview-session-handoff.schema.json',
    outputPath: 'libs/core/src/types/webview-session-handoff.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/web-app-profile.schema.json',
    outputPath: 'libs/core/src/types/web-app-profile.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/ui-flow-adf.schema.json',
    outputPath: 'libs/core/src/types/ui-flow-adf.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/test-case-adf.schema.json',
    outputPath: 'libs/core/src/types/test-case-adf.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/music-generation-adf.schema.json',
    outputPath: 'libs/core/src/types/music-generation-adf.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/image-generation-adf.schema.json',
    outputPath: 'libs/core/src/types/image-generation-adf.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/video-generation-adf.schema.json',
    outputPath: 'libs/core/src/types/video-generation-adf.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/generation-job.schema.json',
    outputPath: 'libs/core/src/types/generation-job.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/generation-schedule.schema.json',
    outputPath: 'libs/core/src/types/generation-schedule.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/proposal-brief.schema.json',
    outputPath: 'libs/core/src/types/proposal-brief.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/proposal-storyline-adf.schema.json',
    outputPath: 'libs/core/src/types/proposal-storyline-adf.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/corporate-design-adf.schema.json',
    outputPath: 'libs/core/src/types/corporate-design-adf.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/document-brief.schema.json',
    outputPath: 'libs/core/src/types/document-brief.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/actuator-execution-brief.schema.json',
    outputPath: 'libs/core/src/types/actuator-execution-brief.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/actuator-resolution-plan.schema.json',
    outputPath: 'libs/core/src/types/actuator-resolution-plan.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/delivery-pack.schema.json',
    outputPath: 'libs/core/src/types/delivery-pack.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/actuator-pipeline-bundle.schema.json',
    outputPath: 'libs/core/src/types/actuator-pipeline-bundle.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/system-status-brief.schema.json',
    outputPath: 'libs/core/src/types/system-status-brief.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/system-status-report.schema.json',
    outputPath: 'libs/core/src/types/system-status-report.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/operator-interaction-packet.schema.json',
    outputPath: 'libs/core/src/types/operator-interaction-packet.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/travel-planning-brief.schema.json',
    outputPath: 'libs/core/src/types/travel-planning-brief.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/booking-preference-profile.schema.json',
    outputPath: 'libs/core/src/types/booking-preference-profile.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/narrated-video-preference-profile.schema.json',
    outputPath: 'libs/core/src/types/narrated-video-preference-profile.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/narrated-video-publish-plan.schema.json',
    outputPath: 'libs/core/src/types/narrated-video-publish-plan.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/narrated-video-upload-package.schema.json',
    outputPath: 'libs/core/src/types/narrated-video-upload-package.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/meeting-operations-profile.schema.json',
    outputPath: 'libs/core/src/types/meeting-operations-profile.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/meeting-operations-brief.schema.json',
    outputPath: 'libs/core/src/types/meeting-operations-brief.ts',
  },
  {
    schemaPath: 'knowledge/public/schemas/points-portal-clickout-usecase.schema.json',
    outputPath: 'libs/core/src/types/points-portal-clickout-usecase.ts',
  },
];

async function main(): Promise<void> {
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
    safeWriteFile(outputPath, compiled);
    console.log(`[generate:types] ${target.outputPath}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
