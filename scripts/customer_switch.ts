#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyError,
  formatClassification,
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeWriteFile,
} from '@agent/core';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const CUSTOMER_ENV_PATH = pathResolver.shared('runtime/customer.env');

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
  const customerDir = path.join(pathResolver.rootDir(), 'customer', slug);
  if (!safeExistsSync(customerDir)) {
    throw new Error(`Customer overlay not found: ${path.relative(pathResolver.rootDir(), customerDir)}. Run pnpm customer:create first.`);
  }

  safeMkdir(path.dirname(CUSTOMER_ENV_PATH), { recursive: true });
  safeWriteFile(CUSTOMER_ENV_PATH, `export KYBERION_CUSTOMER=${slug}\n`, { encoding: 'utf8' });
  return { slug, envPath: CUSTOMER_ENV_PATH };
}

function main(): void {
  const slug = process.argv[2];
  if (!slug || slug === '--help' || slug === '-h') {
    console.error('Usage: customer_switch <slug>');
    process.exit(slug ? 0 : 2);
  }

  try {
    const result = switchCustomer(slug);
    console.log(`Switched customer to ${result.slug}`);
    console.log(`Activation profile: ${path.relative(pathResolver.rootDir(), result.envPath)}`);
    console.log(`Source it with: source ${path.relative(pathResolver.rootDir(), result.envPath)}`);
  } catch (err) {
    console.error(formatClassification(classifyError(err)));
    process.exit(1);
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main();
}
