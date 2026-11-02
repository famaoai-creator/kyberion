/** Reject a value that would land in an argv position but parses as a flag. */
export function assertNotFlagLike(value: string, label: string): void {
  if (!value.trim() || value.trim().startsWith('-') || /\s/u.test(value.trim())) {
    throw new Error(`[VCS_GIT_INVALID] ${label} must be a non-empty, non-flag value`);
  }
}
