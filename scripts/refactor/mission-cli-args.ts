/**
 * scripts/refactor/mission-cli-args.ts
 * CLI argument parsing utilities for the Mission Controller.
 */

import { BOOLEAN_FLAGS, VALUE_FLAGS, type MissionRelationships } from './mission-types.js';

export function extractMissionControllerPositionalArgs(argv: string[]): string[] {
  const rawArgs = argv.slice(2);
  const positionalArgs: string[] = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (BOOLEAN_FLAGS.has(arg)) {
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    positionalArgs.push(arg);
  }

  return positionalArgs;
}

export function getOptionValue(flag: string, argv: string[] = process.argv): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) return undefined;
  return value;
}

export function parseCsvOption(flag: string, argv: string[] = process.argv): string[] | undefined {
  const raw = getOptionValue(flag, argv);
  if (!raw) return undefined;
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

export function extractProjectRelationshipOptionsFromArgv(argv: string[]): Partial<MissionRelationships> {
  const projectId = getOptionValue('--project-id', argv);
  const projectPath = getOptionValue('--project-path', argv);
  const relationshipType = getOptionValue('--project-relationship', argv) as MissionRelationships['project'] extends infer T
    ? T extends { relationship_type: infer R } ? R : never
    : never;
  const affectedArtifacts = parseCsvOption('--affected-artifacts', argv);
  const traceabilityRefs = parseCsvOption('--traceability-refs', argv);
  const gateImpact = getOptionValue('--gate-impact', argv) as MissionRelationships['project'] extends infer T
    ? T extends { gate_impact: infer G } ? G : never
    : never;
  const note = getOptionValue('--project-note', argv);

  const hasProjectOptions = Boolean(
    projectId || projectPath || relationshipType || affectedArtifacts?.length || traceabilityRefs?.length || gateImpact || note
  );

  if (!hasProjectOptions) {
    return {};
  }

  return {
    project: {
      relationship_type: relationshipType || 'independent',
      project_id: projectId,
      project_path: projectPath,
      affected_artifacts: affectedArtifacts || [],
      gate_impact: gateImpact || 'none',
      traceability_refs: traceabilityRefs || [],
      note,
    },
  };
}

export function extractProjectRelationshipOptions(): Partial<MissionRelationships> {
  return extractProjectRelationshipOptionsFromArgv(process.argv);
}
