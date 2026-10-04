import { pathToFileURL } from 'node:url';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeStat } from '../secure-io.js';
import type { MeetingParticipationDriverInstallOptions } from './meeting-join-driver.js';

interface MeetingJoinDriverModuleDescriptor {
  driver_id: string;
  module: string;
  fallback_path?: string;
}

interface MeetingJoinDriverModuleRegistry {
  version: string;
  drivers: MeetingJoinDriverModuleDescriptor[];
}

interface MeetingParticipationDriverModule {
  installMeetingParticipationDriver?: (
    options: MeetingParticipationDriverInstallOptions
  ) => void | Promise<void>;
}

const meetingJoinDriverModuleCatalog = defineCatalog<MeetingJoinDriverModuleRegistry>({
  id: 'meeting-join-driver-modules',
  path: () => pathResolver.knowledge('product/governance/meeting-join-driver-modules.json'),
  schema: pathResolver.knowledge('product/schemas/meeting-join-driver-modules.schema.json'),
});

function findDriverModule(driverId: string): MeetingJoinDriverModuleDescriptor | undefined {
  return meetingJoinDriverModuleCatalog
    .load()
    .drivers.find((descriptor) => descriptor.driver_id === driverId);
}

function resolveFallbackModulePath(relativePath: string): string {
  if (
    !relativePath ||
    relativePath.startsWith('/') ||
    relativePath.split(/[\\/]/u).includes('..')
  ) {
    throw new Error('[meeting-driver-loader] fallback_path must remain repository-relative');
  }
  const safePath = assertSafeRepositoryPath(pathResolver.rootResolve(relativePath));
  if (!safeStat(safePath).isFile()) {
    throw new Error('[meeting-driver-loader] fallback_path must be a regular file');
  }
  return safePath;
}

export interface MeetingJoinDriverModuleLoadResult {
  registered: boolean;
  fallback_path?: string;
}

/** Loads the declared driver installer without dispatching on driver IDs. */
export async function installMeetingParticipationDriver(
  driverId: string,
  options: MeetingParticipationDriverInstallOptions = {}
): Promise<MeetingJoinDriverModuleLoadResult> {
  const descriptor = findDriverModule(driverId);
  if (!descriptor) return { registered: false };

  let driverModule: MeetingParticipationDriverModule;
  let fallbackPath: string | undefined;
  try {
    driverModule = (await import(descriptor.module)) as MeetingParticipationDriverModule;
  } catch (packageError) {
    if (!descriptor.fallback_path) throw packageError;
    fallbackPath = resolveFallbackModulePath(descriptor.fallback_path);
    driverModule = (await import(
      pathToFileURL(fallbackPath).href
    )) as MeetingParticipationDriverModule;
  }

  if (typeof driverModule.installMeetingParticipationDriver !== 'function') {
    throw new Error(
      `[meeting-driver-loader] module for '${driverId}' must export installMeetingParticipationDriver(options)`
    );
  }
  await driverModule.installMeetingParticipationDriver(options);
  return { registered: true, ...(fallbackPath ? { fallback_path: fallbackPath } : {}) };
}
