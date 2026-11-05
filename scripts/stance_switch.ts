#!/usr/bin/env node
import * as path from 'node:path';
import { classifyError, formatClassification } from '@agent/core/error-classifier';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from '@agent/core/secure-io';
import { STANCE_ENV_VAR, stanceDirForSlug } from '@agent/core/stance-resolver';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

type Print = (value: unknown) => void;

/** Activation profile the operator sources to select the stance in a shell. */
export const STANCE_ENV_PATH = pathResolver.shared('runtime/stance.env');
/** Files a stance needs before it can be selected. */
export const STANCE_REQUIRED_FILES = ['stance.json', 'identity.json'];

export function switchStance(slugInput: string): { slug: string; envPath: string } {
  const slug = slugInput.trim();
  const rootDir = pathResolver.rootDir();
  const stanceDir = stanceDirForSlug(slug, rootDir);
  if (!safeExistsSync(stanceDir) || !safeLstat(stanceDir).isDirectory()) {
    throw new Error(
      `Stance not found: ${path.relative(rootDir, stanceDir)}. Run pnpm stance:create first.`
    );
  }

  const missing = STANCE_REQUIRED_FILES.filter((required) => {
    const requiredPath = assertSafeRepositoryPath(path.join(stanceDir, required), {
      allowMissingLeaf: true,
      rootDir,
    });
    return !safeExistsSync(requiredPath) || !safeLstat(requiredPath).isFile();
  });
  if (missing.length > 0) {
    throw new Error(
      `Stance is not ready: ${path.relative(rootDir, stanceDir)} is missing ${missing.join(', ')}. Run pnpm stance:list to inspect readiness.`
    );
  }

  safeMkdir(path.dirname(STANCE_ENV_PATH), { recursive: true });
  safeWriteFile(STANCE_ENV_PATH, `export ${STANCE_ENV_VAR}=${slug}\n`, { encoding: 'utf8' });
  return { slug, envPath: STANCE_ENV_PATH };
}

export function formatSwitchedStance(result: { slug: string; envPath: string }): string[] {
  return [
    `Switched stance to ${result.slug}`,
    `Activation profile: ${path.relative(pathResolver.rootDir(), result.envPath)}`,
    `Source it with: source ${path.relative(pathResolver.rootDir(), result.envPath)}`,
  ];
}

export function main(argv: string[], print: Print = () => undefined): string[] {
  const slug = argv[0];
  if (!slug || slug === '--help' || slug === '-h') {
    const usage = 'Usage: stance_switch <slug>';
    if (slug) {
      print(usage);
      throw new ScriptExitError(0, '', true);
    }
    throw new ScriptExitError(2, usage);
  }

  try {
    const result = switchStance(slug);
    return formatSwitchedStance(result);
  } catch (err) {
    throw new Error(formatClassification(classifyError(err)));
  }
}

if (
  isDirectScript(import.meta.url, 'stance_switch.ts') ||
  isDirectScript(import.meta.url, 'stance_switch.js')
)
  void defineScript({
    name: 'stance:switch',
    flags: [],
    run(context) {
      context.print(main(context.argv, context.print).join('\n'));
    },
  })();
