/**
 * Output-exit redaction for provider CLI reasoning backends.
 *
 * Every text a CLI backend hands back to Kyberion — the final answer, each
 * streamed chunk, and error messages that embed the child's stderr/stdout —
 * passes through here. Needles are the secret-guard active-secret registry
 * plus every provider's credential env value (a CLI reads its key straight
 * from env, so that key is never in the registry). Structured results are
 * walked value-wise via `redactSecretsDeep`; streams use a boundary-aware
 * redactor so a key split across two chunks is still masked.
 */

import { createSecretStreamRedactor, redactSecretValuesInText } from '../secret/secret-guard.js';
import { redactSecretsDeep } from '../secret/secret-redaction.js';
import { providerCredentialEnvValues } from './provider-permission-profiles.js';

function extraSecrets(): string[] {
  return providerCredentialEnvValues();
}

/** Redact one text exit (final answer, transcript line). */
export function redactProviderOutputText(text: string): string {
  return redactSecretValuesInText(text, { extraSecrets: extraSecrets() });
}

/** Redact a structured exit (parsed JSON result, transcript record) value-wise. */
export function redactProviderOutputValue<T>(value: T): T {
  return redactSecretsDeep(value, { extraSecrets: extraSecrets() });
}

/**
 * Redact an error leaving a backend in place: message, stack and own
 * enumerable string properties (e.g. a captured `stderr`) are masked on the
 * same instance, so `instanceof` checks and typed fields that failover
 * classification relies on survive. Non-Error throwables are walked
 * value-wise.
 */
export function redactProviderOutputError(error: unknown): unknown {
  if (!(error instanceof Error)) return redactProviderOutputValue(error);
  const options = { extraSecrets: extraSecrets() };
  try {
    error.message = redactSecretValuesInText(error.message, options);
    if (typeof error.stack === 'string') {
      error.stack = redactSecretValuesInText(error.stack, options);
    }
    const record = error as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string') record[key] = redactSecretValuesInText(value, options);
    }
    return error;
  } catch {
    // Frozen/non-writable error: replace it rather than leak its text.
    const replacement = new Error(redactSecretValuesInText(error.message, options));
    replacement.name = error.name;
    return replacement;
  }
}

/** Wrap a text stream so no yielded chunk carries a secret (boundary-safe). */
export async function* redactProviderOutputStream(
  stream: AsyncIterable<string>
): AsyncGenerator<string, void, undefined> {
  const redactor = createSecretStreamRedactor({ extraSecrets: extraSecrets() });
  try {
    for await (const chunk of stream) {
      const safe = redactor.push(chunk);
      if (safe) yield safe;
    }
  } catch (error) {
    throw redactProviderOutputError(error);
  }
  const rest = redactor.flush();
  if (rest) yield rest;
}

/**
 * Run a backend exit and redact both its result (text or structured,
 * value-wise) and any thrown error.
 */
export async function withRedactedProviderOutput<T>(run: () => Promise<T>): Promise<T> {
  try {
    return redactProviderOutputValue(await run());
  } catch (error) {
    throw redactProviderOutputError(error);
  }
}
