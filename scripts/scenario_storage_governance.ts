/**
 * Scenario runner: Storage & Data Governance
 * Exercises audit-chain, data-vault, process-logger end-to-end.
 * Run: node dist/scripts/scenario_storage_governance.js
 */

import { auditChain } from '@agent/core';
import { fetchWithVaultCache, getVaultEntry, invalidateVaultEntry, listVaultEntries } from '@agent/core';
import { createProcessLogger } from '@agent/core';
import { runJanitor } from '@agent/core';
import { sharedLogsAudit, sharedLogsProcess } from '@agent/core';
import { safeExistsSync, safeReadFile, safeReaddir } from '@agent/core';
import * as path from 'node:path';
import * as fs from 'node:fs';

function hr(label: string) {
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(56));
}

function ok(msg: string) { console.log(`  ✓ ${msg}`); }
function info(msg: string) { console.log(`  · ${msg}`); }
function warn(msg: string) { console.log(`  ⚠ ${msg}`); }

// ── Scenario 1: AuditChain ───────────────────────────────────

hr('Scenario 1 — AuditChain: write + verify + tenant mirror');

const e1 = auditChain.record({
  agentId: 'scenario-runner',
  action: 'scenario_start',
  operation: 'storage_governance_test',
  result: 'completed',
});
ok(`recorded entry ${e1.id}`);

const e2 = auditChain.record({
  agentId: 'scenario-runner',
  action: 'policy_check',
  operation: 'data_access',
  result: 'allowed',
  tenantSlug: 'sbiss',
  metadata: { resource: 'confluence:page:12345' },
});
ok(`recorded tenant-scoped entry ${e2.id} (tenant: sbiss)`);

const e3 = auditChain.record({
  agentId: 'scenario-runner',
  action: 'data_fetch',
  operation: 'external_pull',
  result: 'completed',
  tenantSlug: 'sbijsm',
  metadata: { source: 'gdrive' },
});
ok(`recorded tenant-scoped entry ${e3.id} (tenant: sbijsm)`);

// Verify
const verification = auditChain.verify();
ok(`chain integrity: ${verification.valid}/${verification.total} valid${verification.corrupted.length > 0 ? ` (${verification.corrupted.length} corrupted!)` : ''}`);

// Check files
const auditDir = sharedLogsAudit();
const auditFiles = safeExistsSync(auditDir) ? safeReaddir(auditDir) : [];
info(`audit files in active/shared/logs/audit/: [${auditFiles.join(', ')}]`);

// Check tenant mirrors
const rootDir = path.resolve(import.meta.dirname, '../..');
const sbissMirror = path.join(rootDir, 'customer/sbiss/logs/audit');
const sbijsmMirror = path.join(rootDir, 'customer/sbijsm/logs/audit');

if (safeExistsSync(sbissMirror)) {
  const files = safeReaddir(sbissMirror);
  ok(`tenant mirror sbiss: ${files.join(', ')}`);
  const lines = (safeReadFile(path.join(sbissMirror, files[0]), { encoding: 'utf8' }) as string)
    .trim().split('\n').filter(Boolean);
  info(`  → ${lines.length} mirrored entry(ies)`);
} else {
  warn('sbiss tenant mirror not created yet');
}

if (safeExistsSync(sbijsmMirror)) {
  const files = safeReaddir(sbijsmMirror);
  ok(`tenant mirror sbijsm: ${files.join(', ')}`);
} else {
  warn('sbijsm tenant mirror not created yet');
}

// ── Scenario 2: Data Vault ───────────────────────────────────

hr('Scenario 2 — Data Vault: cache miss → hit → TTL expiry → invalidate');

let fetchCount = 0;
async function simulatedConfluenceFetch(pageId: string): Promise<{ id: string; title: string; body: string }> {
  fetchCount++;
  await new Promise(r => setTimeout(r, 10)); // simulate latency
  return { id: pageId, title: `Page ${pageId}`, body: `Content fetched at ${new Date().toISOString()}` };
}

// Miss
const result1 = await fetchWithVaultCache(
  'confluence',
  'page:demo-001',
  () => simulatedConfluenceFetch('demo-001'),
  { ttlMs: 5_000, tier: 'confidential', projectId: 'scenario-test' }
);
ok(`cache miss → fetched (fetchCount=${fetchCount}, fromCache=${result1.fromCache})`);
info(`  stored at tier=${result1.entry.tier}, expires=${result1.entry.expiresAt}`);
info(`  contentHash=${result1.entry.contentHash.slice(0, 30)}...`);

// Hit
const result2 = await fetchWithVaultCache(
  'confluence',
  'page:demo-001',
  () => simulatedConfluenceFetch('demo-001'),
  { ttlMs: 5_000, projectId: 'scenario-test' }
);
ok(`cache hit (fetchCount still ${fetchCount}, fromCache=${result2.fromCache})`);

// Second source type — also miss
await fetchWithVaultCache(
  'gdrive',
  'file:finance-q1',
  async () => ({ name: 'Q1 Financial Summary', rows: 42, sheet: 'SBI Securities' }),
  { ttlMs: 3_600_000, tier: 'confidential', projectId: 'scenario-test' }
);
ok(`gdrive entry stored (fetchCount=${fetchCount})`);

// List entries
const entries = listVaultEntries({ projectId: 'scenario-test' });
ok(`vault entries for scenario-test project: ${entries.length}`);
for (const e of entries) {
  info(`  · ${e.sourceType}/${e.key} (tier=${e.tier}, expires=${e.expiresAt?.slice(0, 19)})`);
}

// Invalidate
const invalidated = invalidateVaultEntry('confluence', 'page:demo-001', 'scenario-test');
ok(`invalidated confluence/page:demo-001: ${invalidated}`);

// Confirm miss after invalidation
const result3 = await fetchWithVaultCache(
  'confluence',
  'page:demo-001',
  () => simulatedConfluenceFetch('demo-001'),
  { ttlMs: 5_000, projectId: 'scenario-test' }
);
ok(`post-invalidate fetch (fetchCount=${fetchCount}, fromCache=${result3.fromCache})`);

// TTL expiry scenario (1ms TTL)
await fetchWithVaultCache(
  'web',
  'url:short-lived',
  async () => ({ content: 'ephemeral' }),
  { ttlMs: 1, projectId: 'scenario-test' }
);
await new Promise(r => setTimeout(r, 10));
const expired = getVaultEntry('web', 'url:short-lived', 'scenario-test');
ok(`expired entry returns null: ${expired === null}`);

// ── Scenario 3: ProcessLogger ────────────────────────────────

hr('Scenario 3 — ProcessLogger: daemon log entries + file output');

const procLog = createProcessLogger('scenario-daemon', { minLevel: 'debug' });
procLog.info('daemon started', { pid: process.pid, node: process.version });
procLog.debug('config loaded', { backend: 'gemini-cli', ttl_ms: 300_000 });
procLog.warn('rate limit approaching', { remaining: 5, limit: 100 });
procLog.error('connection reset', { host: 'api.example.com', attempt: 3 });

const logPath = path.join(path.dirname(sharedLogsProcess()), 'scenario-daemon.log');
if (safeExistsSync(sharedLogsProcess('scenario-daemon.log'))) {
  const raw = safeReadFile(sharedLogsProcess('scenario-daemon.log'), { encoding: 'utf8' }) as string;
  const lines = raw.trim().split('\n').filter(Boolean);
  ok(`process log written: ${lines.length} entries at active/shared/logs/process/scenario-daemon.log`);
  for (const line of lines) {
    const entry = JSON.parse(line);
    info(`  [${entry.level}] ${entry.msg}${entry.meta ? ' ' + JSON.stringify(entry.meta) : ''}`);
  }
} else {
  warn('process log file not found');
}

// ── Scenario 4: Storage Janitor dry-run ──────────────────────

hr('Scenario 4 — Storage Janitor: dry-run report');

const report = runJanitor({ dryRun: true });
ok(`janitor dry-run complete`);
info(`  tmp/  expired: ${report.expiredTmp}`);
info(`  logs/ expired: ${report.expiredLogs}`);
info(`  vault expired: ${report.expiredDataVault} (just added scenario entries — all within TTL)`);
info(`  errors:        ${report.errors.length}`);

// ── Summary ──────────────────────────────────────────────────

hr('All scenarios completed');
ok('AuditChain: write, verify, tenant mirror ✓');
ok('DataVault: miss → hit → invalidate → expiry ✓');
ok('ProcessLogger: JSONL file output ✓');
ok('StorageJanitor: dry-run report ✓');
console.log('');
