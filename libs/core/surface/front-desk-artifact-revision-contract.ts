/** Browser-safe immutable diagnostic revision selection. No execution authority. */
export type FrontDeskReceiptFormat = 'compact' | 'readable';
/** An inert target selection, never approval or a caller-selected output path. */
export interface FrontDeskArtifactRevisionInput {
  requestId: string;
  revision: number;
  sha256: string;
  format: FrontDeskReceiptFormat;
}
export function parseFrontDeskArtifactRevisionInput(
  value: unknown
): FrontDeskArtifactRevisionInput | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 4 ||
    Object.keys(row).some((key) => !['requestId', 'revision', 'sha256', 'format'].includes(key)) ||
    typeof row.requestId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.requestId) ||
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 1 ||
    (row.revision as number) > 64 ||
    typeof row.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.sha256) ||
    !['compact', 'readable'].includes(String(row.format))
  )
    return undefined;
  return {
    requestId: row.requestId,
    revision: row.revision as number,
    sha256: row.sha256,
    format: row.format as FrontDeskReceiptFormat,
  };
}
/** Exact bounded protocol commands, not natural-language instructions. */
export function frontDeskArtifactRevisionCommand(format: FrontDeskReceiptFormat): string {
  // i18n-exempt: Exact opt-in protocol command; UI labels are localized separately.
  return format === 'compact'
    ? 'Create a compact JSON revision of this diagnostic receipt.'
    : 'Create a readable JSON revision of this diagnostic receipt.';
}
