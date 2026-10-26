import { AsyncLocalStorage } from 'node:async_hooks';

export const MISSION_IDENTITY_FILES = [
  'my-identity.json',
  'my-vision.md',
  'agent-identity.json',
] as const;
export interface MissionPrerequisiteIdentity {
  ready: boolean;
  missing_files: string[];
  next?: string;
}
const probes = new AsyncLocalStorage<() => MissionPrerequisiteIdentity>();

/** Composition-only metadata port: never changes profile paths or grants file access. */
export function withMissionPrerequisiteIdentityProbe<T>(
  probe: () => MissionPrerequisiteIdentity,
  action: () => T
): T {
  return probes.run(probe, action);
}

export function probeMissionPrerequisiteIdentity(): MissionPrerequisiteIdentity | undefined {
  const result = probes.getStore()?.();
  if (!result) return undefined;
  if (
    !Array.isArray(result.missing_files) ||
    result.missing_files.some(
      (name) => !MISSION_IDENTITY_FILES.some((allowed) => allowed === name)
    ) ||
    result.ready !== (result.missing_files.length === 0)
  )
    throw new Error('Invalid mission prerequisite identity metadata');
  return result;
}
