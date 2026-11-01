/**
 * Shared Swift fragments for macOS Keychain writers.
 *
 * Kyberion writes generic passwords from a short-lived `swift -e` helper (so the
 * secret travels over stdin, never argv) and reads them with
 * `/usr/bin/security find-generic-password -w`. Without an explicit access
 * object, macOS trusts only the creating binary — here an ephemeral compiled
 * helper — so every later read needs interactive authorization and fails in
 * launchd / non-interactive contexts. Writers therefore attach an access list
 * that trusts the reader.
 *
 * An item's ACL cannot be changed by a binary it does not trust, and
 * `SecItemUpdate` never changes it, so replacing an existing item means
 * deleting it with the trusted reader and adding it again.
 */

/** The binary every Kyberion keychain reader runs; trusted by written items. */
export const KEYCHAIN_READER_PATH = '/usr/bin/security';

/** `swift` arguments for running a helper script without deprecation noise on stderr. */
export function keychainSwiftArgs(script: string): string[] {
  return ['-suppress-warnings', '-e', script];
}

/**
 * Swift lines that bind `access` (a `SecAccess` trusting
 * {@link KEYCHAIN_READER_PATH}) for an item labelled by the in-scope `service`
 * variable. Exit code 4: the reader could not be resolved; 5: the access
 * object could not be created.
 */
export function keychainReaderAccessSwiftLines(): string[] {
  return [
    'var trustedReader: SecTrustedApplication?',
    `guard SecTrustedApplicationCreateFromPath("${KEYCHAIN_READER_PATH}", &trustedReader) == errSecSuccess, let reader = trustedReader else { exit(4) }`,
    'var accessRef: SecAccess?',
    'guard SecAccessCreate(service as CFString, [reader] as CFArray, &accessRef) == errSecSuccess, let access = accessRef else { exit(5) }',
  ];
}
