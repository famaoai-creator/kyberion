#!/usr/bin/env node
import * as pathResolver from '../libs/core/path-resolver.js';
import { withExecutionContext } from '../libs/core/authority.js';
import { safeRmSync } from '../libs/core/secure-io.js';
import { getAllFiles } from '../libs/core/fs-utils.js';

function removeIfExists(targetPath: string): void {
  safeRmSync(targetPath, { recursive: true, force: true });
}

function main(): void {
  withExecutionContext('mission_controller', () => {
    const previousSudo = process.env.KYBERION_SUDO;
    process.env.KYBERION_SUDO = 'true';
    try {
      removeIfExists(pathResolver.rootResolve('dist'));
      removeIfExists(pathResolver.rootResolve('coverage'));

      for (const file of getAllFiles(pathResolver.rootDir())) {
        if (file.endsWith('.tsbuildinfo')) {
          safeRmSync(file, { force: true });
        }
      }
    } finally {
      if (previousSudo === undefined) delete process.env.KYBERION_SUDO;
      else process.env.KYBERION_SUDO = previousSudo;
    }
  });
}

main();
