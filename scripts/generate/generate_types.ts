import { compileFromFile } from 'json-schema-to-typescript';
import { format as prettierFormat, resolveConfig as resolvePrettierConfig } from 'prettier';
import { pathResolver } from '@agent/core/path-resolver';
import { defineGenerator, isDirectScript, type GeneratedFile } from '../lib/harness.js';

interface GenerationTarget {
  schemaPath: string;
  outputPath: string;
}

export const targets: GenerationTarget[] = [
  {
    schemaPath: 'knowledge/product/schemas/wisdom-action.schema.json',
    outputPath: 'libs/core/contracts/wisdom-action.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/mission-contract.schema.json',
    outputPath: 'libs/core/contracts/mission-contract.ts',
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
    schemaPath: 'knowledge/product/schemas/proposal-storyline-adf.schema.json',
    outputPath: 'libs/core/contracts/proposal-storyline-adf.ts',
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
    schemaPath: 'knowledge/product/schemas/operator-interaction-packet.schema.json',
    outputPath: 'libs/core/contracts/operator-interaction-packet.ts',
  },
  {
    schemaPath: 'knowledge/product/schemas/presentation-preference-profile.schema.json',
    outputPath: 'libs/core/contracts/presentation-preference-profile.ts',
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
];

/**
 * Single-source the storage tier union: schemas declare the enum, the emitted
 * type defers to `StorageDataTier` so the tier vocabulary lives in exactly one
 * module (storage-layout.ts) instead of being reprinted in every contract.
 */
const TIER_UNION_MEMBER = `'(?:personal|confidential|public)'`;
const TIER_UNION_PATTERN = new RegExp(
  `(?<!\\|\\s*)${TIER_UNION_MEMBER}(?:\\s*\\|\\s*${TIER_UNION_MEMBER}){2}(?!\\s*\\|)`,
  'g'
);
const TIER_UNION_MEMBERS = new Set(['personal', 'confidential', 'public']);
const STORAGE_TIER_IMPORT = `import type { StorageDataTier } from '../storage-layout.js';`;

const isTierUnion = (expression: string): boolean => {
  const members = expression.match(/'(\w+)'/g)?.map((literal) => literal.slice(1, -1)) ?? [];
  return (
    members.length === TIER_UNION_MEMBERS.size && members.every((m) => TIER_UNION_MEMBERS.has(m))
  );
};

export function substituteTierUnion(content: string): string {
  let substitutedAny = false;
  const substituted = content.replace(TIER_UNION_PATTERN, (match) => {
    if (!isTierUnion(match)) return match;
    substitutedAny = true;
    return 'StorageDataTier';
  });
  if (!substitutedAny || substituted.includes(STORAGE_TIER_IMPORT)) return substituted;
  return substituted.replace(/\nexport /, `\n${STORAGE_TIER_IMPORT}\nexport `);
}

async function postprocess(content: string): Promise<string> {
  const config = (await resolvePrettierConfig(pathResolver.rootResolve('.prettierrc.json'))) ?? {};
  return prettierFormat(substituteTierUnion(content), { ...config, parser: 'typescript' });
}

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
    files.push({ path: outputPath, content: await postprocess(compiled) });
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
