/**
 * Browser half of the installation-owner model: the stable error codes
 * installation-scope endpoints answer with, so settings panels render a
 * read-only notice or a passkey confirmation instead of a broken 403 state.
 */
export type InstallationAccessCode =
  'authentication_required' | 'installation_owner_required' | 'installation_step_up_required';

const CODES: readonly string[] = [
  'authentication_required',
  'installation_owner_required',
  'installation_step_up_required',
];

export function isInstallationAccessCode(value: unknown): value is InstallationAccessCode {
  return typeof value === 'string' && CODES.includes(value);
}

/** The installation code in a JSON error body (`error` or `error_code`), if any. */
export function installationAccessCodeOf(body: unknown): InstallationAccessCode | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (isInstallationAccessCode(record.error_code)) return record.error_code;
  if (isInstallationAccessCode(record.error)) return record.error;
  return null;
}
