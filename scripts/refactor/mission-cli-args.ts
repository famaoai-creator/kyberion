/**
 * scripts/refactor/mission-cli-args.ts
 * CLI argument parsing utilities for the Mission Controller.
 */

import { safeExistsSync } from '@agent/core';
import { BOOLEAN_FLAGS, VALUE_FLAGS, type MissionRelationships } from './mission-types.js';
import { readJsonFile } from './cli-input.js';

export interface MissionStartCreateOptions {
  tier?: 'personal' | 'confidential' | 'public';
  tenantId?: string;
  /**
   * Tenant slug — multi-tenant isolation key. When set, the resulting
   * mission carries `tenant_slug` and tier-guard / audit-chain enforce
   * cross-tenant isolation.
   */
  tenantSlug?: string;
  missionType?: string;
  visionRef?: string;
  persona?: string;
  relationships?: Partial<MissionRelationships>;
  routingDecision?: string;
}

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

export function extractTrackRelationshipOptionsFromArgv(argv: string[]): Partial<MissionRelationships> {
  const trackId = getOptionValue('--track-id', argv);
  const trackName = getOptionValue('--track-name', argv);
  const trackType = getOptionValue('--track-type', argv) as MissionRelationships['track'] extends infer T
    ? T extends { track_type: infer R } ? R : never
    : never;
  const lifecycleModel = getOptionValue('--lifecycle-model', argv);
  const relationshipType = getOptionValue('--track-relationship', argv) as MissionRelationships['track'] extends infer T
    ? T extends { relationship_type: infer R } ? R : never
    : never;
  const traceabilityRefs = parseCsvOption('--track-traceability-refs', argv);
  const note = getOptionValue('--track-note', argv);

  const hasTrackOptions = Boolean(
    trackId || trackName || trackType || lifecycleModel || relationshipType || traceabilityRefs?.length || note,
  );

  if (!hasTrackOptions) {
    return {};
  }

  return {
    track: {
      relationship_type: relationshipType || 'belongs_to',
      track_id: trackId,
      track_name: trackName,
      track_type: trackType,
      lifecycle_model: lifecycleModel,
      traceability_refs: traceabilityRefs || [],
      note,
    },
  };
}

export function extractProjectRelationshipOptions(): Partial<MissionRelationships> {
  return extractProjectRelationshipOptionsFromArgv(process.argv);
}

export function extractJsonRelationshipsOption(argv: string[] = process.argv): Partial<MissionRelationships> {
  const raw = getOptionValue('--relationships-json', argv) || getOptionValue('--relationships', argv);
  if (!raw) return {};
  return JSON.parse(raw) as Partial<MissionRelationships>;
}

export function extractFileRelationshipsOption(argv: string[] = process.argv): Partial<MissionRelationships> {
  const filePath = getOptionValue('--relationships-file', argv);
  if (!filePath) return {};
  if (!safeExistsSync(filePath)) {
    throw new Error(`Relationships file not found: ${filePath}`);
  }
  return readJsonFile<Partial<MissionRelationships>>(filePath);
}

export function extractMissionStartCreateOptionsFromArgv(argv: string[] = process.argv): MissionStartCreateOptions {
  const tenantSlug = getOptionValue('--tenant-slug', argv);
  return {
    tier: getOptionValue('--tier', argv) as MissionStartCreateOptions['tier'] | undefined,
    tenantId: getOptionValue('--tenant-id', argv) || getOptionValue('--tenant', argv),
    ...(tenantSlug ? { tenantSlug } : {}),
    missionType: getOptionValue('--mission-type', argv),
    visionRef: getOptionValue('--vision-ref', argv) || getOptionValue('--vision', argv),
    persona: getOptionValue('--persona', argv),
    routingDecision: getOptionValue('--routing-decision', argv),
    relationships: {
      ...extractJsonRelationshipsOption(argv),
      ...extractFileRelationshipsOption(argv),
      ...extractProjectRelationshipOptionsFromArgv(argv),
      ...extractTrackRelationshipOptionsFromArgv(argv),
    },
  };
}
