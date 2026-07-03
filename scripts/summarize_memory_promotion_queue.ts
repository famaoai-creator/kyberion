import { listMemoryPromotionCandidates, pathResolver, safeWriteFile } from '@agent/core';

interface QueueSummaryRow {
  candidate_id: string;
  status: string;
  proposed_memory_kind: string;
  sensitivity_tier: string;
  source_ref: string;
  queued_at: string;
  age_days: number;
  occurrences: number;
  ratification_required: boolean;
}

function computeAgeDays(queuedAt: string): number {
  const ts = Date.parse(queuedAt);
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, Math.round(((Date.now() - ts) / (1000 * 60 * 60 * 24)) * 10) / 10);
}

export function summarizeMemoryPromotionQueue(status?: string): QueueSummaryRow[] {
  const filterStatus = String(status || '')
    .trim()
    .toLowerCase();
  return listMemoryPromotionCandidates()
    .filter((row) => (filterStatus ? row.status === filterStatus : true))
    .sort((a, b) => b.queued_at.localeCompare(a.queued_at))
    .map((row) => ({
      candidate_id: row.candidate_id,
      status: row.status,
      proposed_memory_kind: row.proposed_memory_kind,
      sensitivity_tier: row.sensitivity_tier,
      source_ref: row.source_ref,
      queued_at: row.queued_at,
      age_days: computeAgeDays(row.queued_at),
      occurrences: typeof row.occurrences === 'number' && row.occurrences > 0 ? row.occurrences : 1,
      ratification_required: row.ratification_required,
    }));
}

function formatMarkdown(rows: QueueSummaryRow[]): string {
  const lines = [
    '# Memory Promotion Queue Summary',
    '',
    '| Candidate | Status | Kind | Tier | Occurrences | Age (days) | Ratification | Source |',
    '|---|---|---|---|---:|---:|---|---|',
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.candidate_id} | ${row.status} | ${row.proposed_memory_kind} | ${row.sensitivity_tier} | ${row.occurrences} | ${row.age_days.toFixed(1)} | ${row.ratification_required ? 'yes' : 'no'} | ${row.source_ref} |`
    );
  }
  if (rows.length === 0) {
    lines.push('| - | - | - | - | - | - | - | - |');
  }
  lines.push('');
  lines.push(`rows=${rows.length}`);
  return lines.join('\n');
}

function main() {
  const jsonOnly = process.argv.includes('--json');
  const statusArgIndex = process.argv.indexOf('--status');
  const outputArgIndex = process.argv.indexOf('--output');
  const status = statusArgIndex >= 0 ? process.argv[statusArgIndex + 1] : undefined;
  const outputPath = outputArgIndex >= 0 ? process.argv[outputArgIndex + 1] : undefined;
  const rows = summarizeMemoryPromotionQueue(status);

  if (outputPath) {
    const absPath = pathResolver.resolve(outputPath);
    safeWriteFile(
      absPath,
      jsonOnly ? `${JSON.stringify({ rows }, null, 2)}\n` : `${formatMarkdown(rows)}\n`
    );
  }

  if (jsonOnly) {
    console.log(JSON.stringify({ rows }, null, 2));
    return;
  }
  console.log(formatMarkdown(rows));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
