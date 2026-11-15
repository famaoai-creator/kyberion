export type SetupCountEntry = [label: string, value: number];

export function formatSetupSummaryLine(entries: SetupCountEntry[]): string {
  const parts = entries
    .filter(([, value]) => Number.isFinite(value))
    .map(([label, value]) => `${value} ${label}`);
  return `Setup summary: ${parts.join(', ')}`;
}

export function formatSetupHintLine(message: string): string {
  return `  ↳ ${message}`;
}
