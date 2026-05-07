import * as path from 'node:path';
import { rawExistsSync } from './fs-primitives.js';
import * as pathResolver from './path-resolver.js';

/**
 * Customer Aggregation Resolver
 *
 * Resolves per-customer configuration paths for FDE / implementation-support engagements.
 * When KYBERION_CUSTOMER is set, paths under customer/{slug}/ overlay knowledge/personal/.
 */

const CUSTOMER_ENV_VAR = 'KYBERION_CUSTOMER';
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export class InvalidCustomerSlugError extends Error {
  constructor(slug: string) {
    super(
      `Invalid ${CUSTOMER_ENV_VAR}: "${slug}". Must match ${SLUG_PATTERN.source} ` +
        `(lowercase ASCII, digits, hyphen, underscore; must start with letter or digit).`,
    );
    this.name = 'InvalidCustomerSlugError';
  }
}

/** Returns the active customer slug from env, or null if none set. Throws on invalid slug. */
export function activeCustomer(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[CUSTOMER_ENV_VAR];
  if (!raw || raw.trim() === '') return null;
  const slug = raw.trim();
  if (!SLUG_PATTERN.test(slug)) throw new InvalidCustomerSlugError(slug);
  return slug;
}

/** Returns the customer root directory for the active slug, or null if no slug active. */
export function customerRoot(subPath = '', env: NodeJS.ProcessEnv = process.env): string | null {
  const slug = activeCustomer(env);
  if (!slug) return null;
  const base = path.join(pathResolver.rootDir(), 'customer', slug);
  return subPath ? path.join(base, subPath) : base;
}

/**
 * Resolve a config path with customer overlay precedence.
 * Order: customer/{slug}/{subPath} → knowledge/personal/{subPath}.
 * Returns the first existing path; if neither exists, returns the customer path
 * (when slug is active) or the personal path (otherwise) so callers can use it for writes.
 */
export function resolveOverlay(subPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const customerPath = customerRoot(subPath, env);
  if (customerPath && rawExistsSync(customerPath)) return customerPath;
  const personalPath = pathResolver.knowledge(path.join('personal', subPath));
  if (rawExistsSync(personalPath)) return personalPath;
  // Neither exists. Prefer customer for writes when active, else personal.
  return customerPath ?? personalPath;
}

/** Returns both candidate paths (customer overlay + personal fallback) for callers
 *  that want to read both (e.g. for deep merge of policy overrides). */
export function overlayCandidates(
  subPath: string,
  env: NodeJS.ProcessEnv = process.env,
): { overlay: string | null; base: string } {
  return {
    overlay: customerRoot(subPath, env),
    base: pathResolver.knowledge(path.join('personal', subPath)),
  };
}

/** Returns true if a customer slug is active and the directory exists. */
export function customerIsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const root = customerRoot('', env);
  return root != null && rawExistsSync(root);
}

export const __test__ = { SLUG_PATTERN, CUSTOMER_ENV_VAR };
