#!/usr/bin/env node
// Source imports on purpose: clean runs BEFORE build on a fresh checkout, so
// @agent/core's dist entry points do not exist yet (CI chicken-and-egg).
// Keep ALL imports source-side here — never mix source and dist registries.
import * as path from 'node:path';
import { withExecutionContext } from '../libs/core/authority.js';
import { safeRmSync } from '../libs/core/secure-io.js';
import { pathResolver } from '../libs/core/path-resolver.js';
import { getAllFiles } from '../libs/core/fs-utils.js';
import { findSensitivePathMatch } from '../libs/core/sensitive-path-policy.js';
import { getRegisteredEnvText, setRegisteredEnv } from '../libs/core/foundation/env.js';
import { defineScript, isDirectScript } from './lib/harness.js';

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

function main(): void {
  withExecutionContext('mission_controller', () => {
    const previousSudo = getRegisteredEnvText('KYBERION_SUDO');
    setRegisteredEnv('KYBERION_SUDO', 'true');
    try {
      removeIfExists(pathResolver.rootResolve('dist'));
      removeIfExists(pathResolver.rootResolve('coverage'));

      for (const file of getAllFiles(pathResolver.rootDir())) {
        if (file.endsWith('.tsbuildinfo') && isProjectGeneratedFile(file)) {
          safeRmSync(file, { force: true });
        }
      }
    } finally {
      setRegisteredEnv('KYBERION_SUDO', previousSudo);
    }
  });
}

export const runClean = defineScript({
  name: 'clean',
  flags: [],
  run() {
    main();
  },
});

if (isDirectScript(import.meta.url, 'clean.ts') || isDirectScript(import.meta.url, 'clean.js'))
  void runClean();
