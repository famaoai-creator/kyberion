/**
 * Synchronous shared budget reservation port for live semantic_judgment calls.
 *
 * Bridges `DotSemanticSharedBudgetPort`'s atomic `reserve` / `holdUnknown` / `settle`
 * contract to Kyberion's existing daily dot token ledger (`dot-token-usage.jsonl`)
 * and organization budget governor (`org-budget-governor.ts`) using `withLockSync`.
 */

import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from '../logger.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir } from '../secure-io.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { appendJsonLine, readJsonIfPresent, writeJson } from '../foundation/json.js';
import { evaluateBudgetThrottle, type OrgBudgetScope } from '../governance/org-budget-governor.js';
import type { DotCharter } from './dot-charter.js';
import {
  DOT_TOKEN_USAGE_PATH,
  maintainDotTokenUsageAfterAppend,
  readDotTokenUsageForDay,
  type DotTokenUsageEntry,
} from './dot-token-usage.js';
import { judgmentCanonicalHash } from '../organization/judgment-precedents.js';
import type { DotSemanticBudgetOwner, DotSemanticKnownUsage } from './dot-semantic-judgment.js';

const logger = createLogger('dot-semantic-budget');

export const DOT_SEMANTIC_BUDGET_STORE_PATH = 'active/shared/runtime/dot/semantic-budget.json';
const DEFAULT_SEMANTIC_DAILY_TOKEN_CAP = 100_000;
const RESERVATION_TTL_MS = 10 * 60_000;

export interface DotSemanticLiveBudgetPort {
  mode: 'live_shared';
  reserve(input: {
    parent: DotSemanticBudgetOwner;
    reservation_key: string;
    max_tokens: number;
  }):
    | { status: 'reserved'; handle: object; owner: DotSemanticBudgetOwner; token_allowance: number }
    | { status: 'unavailable' };
  holdUnknown(handle: object, parent: DotSemanticBudgetOwner): { status: 'held_unknown' };
  settle(
    handle: object,
    parent: DotSemanticBudgetOwner,
    usage: DotSemanticKnownUsage
  ): { status: 'settled' };
}

interface StoredReservation {
  id: string;
  reservation_key: string;
  owner_hash: string;
  dot_id: string;
  accounting_id: string;
  day: string;
  reserved_tokens: number;
  status: 'reserved' | 'held_unknown' | 'settled';
  used_tokens?: number;
  usage_hash?: string;
  created_at_ms: number;
  updated_at_ms: number;
}

interface BudgetStoreDoc {
  version: 1;
  reservations: StoredReservation[];
}

export interface DotSemanticSharedBudgetOptions {
  rootDir?: string;
  now?: () => Date;
  dailyTokenCap?: number;
  charter?: DotCharter;
  scope?: OrgBudgetScope;
  /** Override org governor read (primarily for deterministic tests). */
  readOrgDailyCap?: (scope: OrgBudgetScope) => number;
}

interface HandleRecord {
  id: string;
  ownerHash: string;
  storeFile: string;
}

function storePath(rootDir: string | undefined): string {
  return path.join(rootDir ?? pathResolver.rootDir(), DOT_SEMANTIC_BUDGET_STORE_PATH);
}

function usagePath(rootDir: string | undefined): string {
  return path.join(rootDir ?? pathResolver.rootDir(), DOT_TOKEN_USAGE_PATH);
}

function lockKeyFor(file: string): string {
  return 'dot-semantic-budget:' + createHash('sha256').update(path.resolve(file)).digest('hex');
}

function readStore(file: string, day: string, nowMs: number): BudgetStoreDoc {
  const existing = readJsonIfPresent<BudgetStoreDoc>(file);
  const rows = Array.isArray(existing?.reservations) ? existing.reservations : [];
  // Keep today's entries and drop expired unheld reservations / previous-day rows on write.
  const active = rows.filter((row) => {
    if (!row || typeof row !== 'object' || row.day !== day) return false;
    if (row.status === 'reserved' && nowMs - row.created_at_ms > RESERVATION_TTL_MS) return false;
    return true;
  });
  return { version: 1, reservations: active };
}

function writeStore(file: string, doc: BudgetStoreDoc): void {
  safeMkdir(path.dirname(file), { recursive: true });
  writeJson(file, doc);
}

function resolveEffectiveDailyCap(options: DotSemanticSharedBudgetOptions, now: Date): number {
  const candidates: number[] = [DEFAULT_SEMANTIC_DAILY_TOKEN_CAP];
  if (
    typeof options.dailyTokenCap === 'number' &&
    Number.isFinite(options.dailyTokenCap) &&
    options.dailyTokenCap > 0
  ) {
    candidates.push(Math.floor(options.dailyTokenCap));
  }
  const charterCap = options.charter?.goal.budget?.token_cap_per_day;
  if (typeof charterCap === 'number' && Number.isFinite(charterCap) && charterCap > 0) {
    candidates.push(Math.floor(charterCap));
  }
  const scope: OrgBudgetScope =
    options.scope ??
    (options.charter
      ? {
          ...(options.charter.scope.tenant_slug
            ? { tenant_slug: options.charter.scope.tenant_slug }
            : {}),
          ...(options.charter.scope.organization_id
            ? { organization_id: options.charter.scope.organization_id }
            : {}),
        }
      : {});
  try {
    const orgCap = options.readOrgDailyCap
      ? options.readOrgDailyCap(scope)
      : evaluateBudgetThrottle(scope, {
          rootDir: options.rootDir,
          now: () => now,
          throttleCacheMs: 0,
        }).cap.daily_token_cap;
    if (typeof orgCap === 'number' && Number.isFinite(orgCap) && orgCap > 0) {
      candidates.push(Math.floor(orgCap));
    }
  } catch (error) {
    logger.warn(
      `[dot-semantic-budget] org cap lookup unavailable, keeping bounded fallback: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return Math.max(0, Math.min(...candidates));
}

function tokensCommittedToday(
  dotId: string,
  day: string,
  doc: BudgetStoreDoc,
  tokenUsageFile: string
): number {
  const spent = readDotTokenUsageForDay<DotTokenUsageEntry>(tokenUsageFile, day)
    .filter((row) => row?.dot_id === dotId)
    .reduce((sum, row) => sum + (Number(row.tokens) || 0), 0);
  const outstanding = doc.reservations
    .filter(
      (row) =>
        row.dot_id === dotId &&
        row.day === day &&
        (row.status === 'reserved' || row.status === 'held_unknown')
    )
    .reduce((sum, row) => sum + (Number(row.reserved_tokens) || 0), 0);
  return spent + outstanding;
}

/**
 * Create a synchronous file-locked shared budget port for live semantic judgment.
 */
export function createDotSemanticSharedBudgetPort(
  options: DotSemanticSharedBudgetOptions = {}
): DotSemanticLiveBudgetPort {
  const handles = new WeakMap<object, HandleRecord>();
  const file = storePath(options.rootDir);
  const tokenUsageFile = usagePath(options.rootDir);
  const nowFn = options.now ?? (() => new Date());

  const requireHandle = (handle: object, parent: DotSemanticBudgetOwner): HandleRecord => {
    const record = handles.get(handle);
    if (!record || record.storeFile !== file) {
      throw new Error('Foreign semantic budget reservation handle');
    }
    const ownerHash = judgmentCanonicalHash(parent);
    if (record.ownerHash !== ownerHash) {
      throw new Error('Semantic budget reservation owner mismatch');
    }
    return record;
  };

  return {
    mode: 'live_shared',

    reserve({ parent, reservation_key, max_tokens }) {
      const requested = Math.floor(max_tokens);
      if (!Number.isFinite(requested) || requested <= 0) return { status: 'unavailable' };
      const now = nowFn();
      const nowMs = now.getTime();
      const today = now.toISOString().slice(0, 10);
      if (parent.day !== today) return { status: 'unavailable' };
      const ownerHash = judgmentCanonicalHash(parent);

      return withLockSync(lockKeyFor(file), () => {
        const doc = readStore(file, parent.day, nowMs);
        const cap = resolveEffectiveDailyCap(options, now);
        const committed = tokensCommittedToday(parent.dot_id, parent.day, doc, tokenUsageFile);
        const remaining = cap - committed;
        if (remaining <= 0) return { status: 'unavailable' };
        const allowance = Math.min(requested, remaining);
        const id = createHash('sha256')
          .update(`${ownerHash}:${reservation_key}:${nowMs}:${doc.reservations.length}`)
          .digest('hex')
          .slice(0, 24);
        doc.reservations.push({
          id,
          reservation_key,
          owner_hash: ownerHash,
          dot_id: parent.dot_id,
          accounting_id: parent.accounting_id,
          day: parent.day,
          reserved_tokens: allowance,
          status: 'reserved',
          created_at_ms: nowMs,
          updated_at_ms: nowMs,
        });
        writeStore(file, doc);
        const handle = Object.freeze({ id });
        handles.set(handle, { id, ownerHash, storeFile: file });
        return {
          status: 'reserved' as const,
          handle,
          owner: structuredClone(parent),
          token_allowance: allowance,
        };
      });
    },

    holdUnknown(handle, parent) {
      const record = requireHandle(handle, parent);
      const nowMs = nowFn().getTime();
      return withLockSync(lockKeyFor(file), () => {
        const doc = readStore(file, parent.day, nowMs);
        const entry = doc.reservations.find((row) => row.id === record.id);
        if (!entry || entry.owner_hash !== record.ownerHash) {
          throw new Error('Semantic budget reservation not found');
        }
        if (entry.status === 'settled') {
          throw new Error('Cannot hold an already settled semantic budget reservation');
        }
        entry.status = 'held_unknown';
        entry.updated_at_ms = nowMs;
        writeStore(file, doc);
        return { status: 'held_unknown' as const };
      });
    },

    settle(handle, parent, usage) {
      const record = requireHandle(handle, parent);
      const now = nowFn();
      const nowMs = now.getTime();
      const usageHash = judgmentCanonicalHash({
        calls: usage.calls,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        usage_status: usage.usage_status,
      });
      const usedTokens = Math.max(0, usage.input_tokens + usage.output_tokens);

      return withLockSync(lockKeyFor(file), () => {
        const doc = readStore(file, parent.day, nowMs);
        const entry = doc.reservations.find((row) => row.id === record.id);
        if (!entry || entry.owner_hash !== record.ownerHash) {
          throw new Error('Semantic budget reservation not found');
        }
        if (entry.status === 'settled') {
          if (entry.usage_hash !== usageHash) {
            throw new Error('Semantic budget reservation already settled with different usage');
          }
          return { status: 'settled' as const };
        }
        entry.status = 'settled';
        entry.used_tokens = usedTokens;
        entry.usage_hash = usageHash;
        entry.updated_at_ms = nowMs;
        writeStore(file, doc);

        if (usedTokens > 0) {
          safeMkdir(path.dirname(tokenUsageFile), { recursive: true });
          appendJsonLine(tokenUsageFile, {
            dot_id: parent.dot_id,
            accounting_id: parent.accounting_id,
            day: parent.day,
            tokens: usedTokens,
            recorded_at: now.toISOString(),
          } satisfies DotTokenUsageEntry);
          maintainDotTokenUsageAfterAppend(tokenUsageFile, now);
        }
        return { status: 'settled' as const };
      });
    },
  };
}
