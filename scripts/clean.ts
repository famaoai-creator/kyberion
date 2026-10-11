#!/usr/bin/env node
// Source imports on purpose: clean runs BEFORE build on a fresh checkout, so
// @agent/core's dist entry points do not exist yet (CI chicken-and-egg).
// Keep ALL imports source-side here — never mix source and dist registries.
import * as path from 'node:path';
import { withExecutionContext } from '../libs/core/authority.js';
import { safeRmSync } from '../libs/core/secure-io.js';
import { pathResolver } from '../libs/core/path-resolver.js';
import { OWNED_BUILD_DIRECTORIES, OWNED_BUILD_METADATA } from './build-output-layout.js';
import { findSensitivePathMatch } from '../libs/core/sensitive-path-policy.js';
import { getRegisteredEnvText, setRegisteredEnv } from '../libs/core/foundation/env.js';

function removeIfExists(targetPath: string): void {
  if (!isProjectGeneratedFile(targetPath)) return;
  safeRmSync(targetPath, { recursive: true, force: true });
}

function isProjectGeneratedFile(filePath: string): boolean {
  const root = path.resolve(pathResolver.rootDir());
  const candidate = path.resolve(filePath);
  const relative = path.relative(root, candidate);
  if (
    relative !== '' &&
    (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
  ) {
    return false;
  }
  return findSensitivePathMatch(candidate) === null;
}

function main(rootDir: string): void {
  withExecutionContext('mission_controller', () => {
    const previousSudo = getRegisteredEnvText('KYBERION_SUDO');
    setRegisteredEnv('KYBERION_SUDO', 'true');
    try {
      for (const output of [...OWNED_BUILD_DIRECTORIES, ...OWNED_BUILD_METADATA]) {
        removeIfExists(path.resolve(rootDir, output));
      }
    } finally {
      setRegisteredEnv('KYBERION_SUDO', previousSudo);
    }
  });
}

/** Clean must remain runnable before any workspace package has been built. */
export function runClean(rootDir = pathResolver.rootDir()): void {
  main(rootDir);
}
