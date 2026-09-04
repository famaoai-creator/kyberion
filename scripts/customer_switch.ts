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
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

type Print = (value: unknown) => void;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const CUSTOMER_ENV_PATH = pathResolver.shared('runtime/customer.env');
const REQUIRED_FILES = ['customer.json', 'identity.json', 'vision.md'];

export class InvalidCustomerSlugError extends Error {
  constructor(slug: string) {
    super(`Invalid customer slug: "${slug}". Must match ${SLUG_PATTERN.source}.`);
    this.name = 'InvalidCustomerSlugError';
  }
}

function validateSlug(slug: string): string {
  const normalized = slug.trim();
  if (!SLUG_PATTERN.test(normalized)) {
    throw new InvalidCustomerSlugError(slug);
  }
  return normalized;
}

export function switchCustomer(slugInput: string): { slug: string; envPath: string } {
  const slug = validateSlug(slugInput);
  const rootDir = pathResolver.rootDir();
  const customerDir = assertSafeRepositoryPath(path.join(rootDir, 'customer', slug), {
    allowMissingLeaf: true,
    rootDir,
  });
  if (!safeExistsSync(customerDir) || !safeLstat(customerDir).isDirectory()) {
    throw new Error(
      `Customer overlay not found: ${path.relative(pathResolver.rootDir(), customerDir)}. Run pnpm customer:create first.`
    );
  }

  const missing = REQUIRED_FILES.filter((required) => {
    const requiredPath = assertSafeRepositoryPath(path.join(customerDir, required), {
      allowMissingLeaf: true,
      rootDir,
    });
    return !safeExistsSync(requiredPath) || !safeLstat(requiredPath).isFile();
  });
  if (missing.length > 0) {
    throw new Error(
      `Customer overlay is not ready: ${path.relative(pathResolver.rootDir(), customerDir)} is missing ${missing.join(', ')}. Run pnpm customer:list to inspect readiness.`
    );
  }

  safeMkdir(path.dirname(CUSTOMER_ENV_PATH), { recursive: true });
  safeWriteFile(CUSTOMER_ENV_PATH, `export KYBERION_CUSTOMER=${slug}\n`, { encoding: 'utf8' });
  return { slug, envPath: CUSTOMER_ENV_PATH };
}

export function formatSwitchedCustomer(result: { slug: string; envPath: string }): string[] {
  return [
    `Switched customer to ${result.slug}`,
    `Activation profile: ${path.relative(pathResolver.rootDir(), result.envPath)}`,
    `Source it with: source ${path.relative(pathResolver.rootDir(), result.envPath)}`,
  ];
}

export function main(argv: string[], print: Print = () => undefined): string[] {
  const slug = argv[0];
  if (!slug || slug === '--help' || slug === '-h') {
    const usage = 'Usage: customer_switch <slug>';
    if (slug) {
      print(usage);
      throw new ScriptExitError(0, '', true);
    }
    throw new ScriptExitError(2, usage);
  }

  try {
    const result = switchCustomer(slug);
    return formatSwitchedCustomer(result);
  } catch (err) {
    throw new Error(formatClassification(classifyError(err)));
  }
}

if (
  isDirectScript(import.meta.url, 'customer_switch.ts') ||
  isDirectScript(import.meta.url, 'customer_switch.js')
)
  void defineScript({
    name: 'customer:switch',
    flags: [],
    run(context) {
      context.print(main(context.argv, context.print).join('\n'));
    },
  })();
