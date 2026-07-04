#!/usr/bin/env node
import * as path from 'node:path';
import { withExecutionContext } from '@agent/core';
import { safeRmSync } from '@agent/core';
import { pathResolver } from '@agent/core';
import { getAllFiles } from '@agent/core';

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
