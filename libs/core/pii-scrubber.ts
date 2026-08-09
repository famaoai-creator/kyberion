/**
 * DA-06 PII・秘匿ガード — the ingest 関所 that makes the declared-but-unread
 * `security.pii_patterns` of knowledge-sync-rules.json real, mechanizing the
 * knowledge-protocol.md 「必ず抽象化・匿名化」 mandate for ingested documents.
 *
 * Rule source: knowledge/product/governance/knowledge-sync-rules.json →
 * `security.pii_patterns`. The loader is tolerant of both shapes:
 *   - legacy `{ name, regex }` secret markers (default severity 'secret',
 *     action 'block') — these keep their `name` field because
 *     tier-guard's marker scan (scanForConfidentialMarkers, consumed by
 *     scripts/compliance_checker.ts) only picks up `name`-bearing entries;
 *   - extended `{ id, regex, description, severity, action, validator }`
 *     PII detectors, which deliberately OMIT `name` so broad patterns
 *     (email, phone, card numbers) do not flood the tier-guard marker scan
 *     with false positives on legitimately public documents.
 *
 * Regex-impossible detectors carry a `validator`:
 *   - 'luhn'        — 13-19 digit payment card numbers, Luhn check digit;
 *   - 'jp_mynumber' — 12-digit マイナンバー, 番号法 check-digit algorithm
 *                     (Q_n = n+1 for n≤6, n−5 for n≥7 over the 11 body
 *                     digits counted from the right; check = 0 when
 *                     S mod 11 ≤ 1, else 11 − S mod 11).
 *
 * 個人名 (personal name) detection is intentionally ABSENT: Japanese names
 * have no reliable orthographic markers (no capitalization, kanji names are
 * indistinguishable from common nouns and place names), and marker
 * heuristics such as 氏名:/様-suffix produce unacceptable false-positive AND
 * false-negative rates. Pretending a regex covers names would be a false
 * sense of security — name anonymization stays a human-review concern via
 * the KM-03 steward loop (see ingest-tier-gate.ts).
 *
 * Fail-closed: a missing/corrupt rules file, an empty pattern list, an
 * uncompilable regex or an unknown severity/action/validator all THROW —
 * the ingest gate must never silently degrade to "no rules, everything
 * passes". Findings NEVER contain the raw matched text: previews are
 * masked to first 2 + last 2 characters for PII and fully masked for
 * secrets.
 */

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';

export type PiiSeverity = 'secret' | 'pii';
export type PiiAction = 'block' | 'mask';
export type PiiValidator = 'luhn' | 'jp_mynumber';

export interface PiiRule {
  id: string;
  description: string;
  severity: PiiSeverity;
  action: PiiAction;
  /** Regex source (compiled per scan with the 'g' flag). */
  pattern: string;
  validator?: PiiValidator;
}

export interface PiiRuleOptions {
  /** Test seam: fixture rules file instead of knowledge-sync-rules.json. */
  rulesPath?: string;
}

export interface PiiFinding {
  rule_id: string;
  severity: PiiSeverity;
  action: PiiAction;
  /** Masked preview — first 2 + last 2 chars for PII, full mask for secrets. */
  match_preview: string;
  /** 1-based line of the first match. */
  line: number;
  count: number;
}

export interface PiiScanResult {
  findings: PiiFinding[];
}

/** Internal redaction coordinates. Raw matched text is intentionally absent. */
export interface PiiSpan {
  start: number;
  end: number;
  rule_id: string;
  severity: PiiSeverity;
  action: PiiAction;
}

export interface PiiScrubApplication {
  rule_id: string;
  count: number;
  /** True when a block-action rule was downgraded to mask by an operator override. */
  overridden: boolean;
}

export interface PiiScrubOptions extends PiiRuleOptions {
  /** Rule ids whose 'block' action is downgraded to 'mask' (operator override). */
  override_rule_ids?: string[];
}

export interface PiiScrubResult {
  scrubbed_text: string;
  applied: PiiScrubApplication[];
  blocked: boolean;
  block_reasons: string[];
}

const SEVERITIES: readonly PiiSeverity[] = ['secret', 'pii'];
const ACTIONS: readonly PiiAction[] = ['block', 'mask'];
const VALIDATORS: readonly PiiValidator[] = ['luhn', 'jp_mynumber'];

function fail(message: string): never {
  throw new Error(`[pii-scrubber] ${message}`);
}

function defaultRulesPath(): string {
  return pathResolver.knowledge('product/governance/knowledge-sync-rules.json');
}

function codepointSort(values: string[]): string[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Loads and validates the rule table. Fail-closed: any structural problem
 * throws — the ingest gate must not run with a partial rule set.
 */
export function loadPiiRules(options: PiiRuleOptions = {}): PiiRule[] {
  const rulesPath = options.rulesPath ?? defaultRulesPath();
  if (!safeExistsSync(rulesPath)) {
    fail(`rules file not found: ${rulesPath} — the ingest PII gate cannot run without rules`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(safeReadFile(rulesPath, { encoding: 'utf8' })));
  } catch (err) {
    fail(`rules file ${rulesPath} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  const entries = (parsed as { security?: { pii_patterns?: unknown } })?.security?.pii_patterns;
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(`security.pii_patterns in ${rulesPath} must be a non-empty array`);
  }
  const rules: PiiRule[] = [];
  const seen = new Set<string>();
  for (const raw of entries as Array<Record<string, unknown>>) {
    const id = String(raw?.id ?? raw?.name ?? '').trim();
    if (!id) fail('every pii_patterns entry needs an id (or legacy name)');
    if (seen.has(id)) fail(`duplicate pii_patterns id '${id}'`);
    seen.add(id);
    const pattern = typeof raw?.regex === 'string' ? raw.regex : '';
    if (!pattern) fail(`pattern '${id}' has no regex`);
    try {
      // Compile once to fail closed on malformed patterns.
      void new RegExp(pattern, 'g');
    } catch (err) {
      fail(`pattern '${id}' does not compile: ${err instanceof Error ? err.message : err}`);
    }
    const severity = (raw?.severity ?? 'secret') as PiiSeverity;
    if (!SEVERITIES.includes(severity)) fail(`pattern '${id}' has unknown severity '${severity}'`);
    const action = (raw?.action ?? (severity === 'secret' ? 'block' : 'mask')) as PiiAction;
    if (!ACTIONS.includes(action)) fail(`pattern '${id}' has unknown action '${action}'`);
    const validator = raw?.validator as PiiValidator | undefined;
    if (validator !== undefined && !VALIDATORS.includes(validator)) {
      fail(`pattern '${id}' has unknown validator '${validator}'`);
    }
    rules.push({
      id,
      description: typeof raw?.description === 'string' ? raw.description : '',
      severity,
      action,
      pattern,
      ...(validator ? { validator } : {}),
    });
  }
  return rules.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** Luhn check over the digits of a candidate card number (13-19 digits). */
export function passesLuhn(candidate: string): boolean {
  const digits = String(candidate || '').replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * 番号法 check-digit validation for a 12-digit マイナンバー. P_n is the body
 * digit at position n counted from the RIGHT of the 11 leading digits;
 * Q_n = n+1 (n ≤ 6) or n−5 (n ≥ 7); check = 0 when Σ P_n·Q_n mod 11 ≤ 1,
 * else 11 − (Σ mod 11).
 */
export function passesMyNumberChecksum(candidate: string): boolean {
  const digits = String(candidate || '').replace(/\D/g, '');
  if (digits.length !== 12) return false;
  let sum = 0;
  for (let n = 1; n <= 11; n += 1) {
    const p = digits.charCodeAt(11 - n) - 48;
    const q = n <= 6 ? n + 1 : n - 5;
    sum += p * q;
  }
  const remainder = sum % 11;
  const check = remainder <= 1 ? 0 : 11 - remainder;
  return check === digits.charCodeAt(11) - 48;
}

function matchIsReal(rule: PiiRule, match: string): boolean {
  if (rule.validator === 'luhn') return passesLuhn(match);
  if (rule.validator === 'jp_mynumber') return passesMyNumberChecksum(match);
  return true;
}

/** Masked preview — the raw match must NEVER leave this module. */
function maskPreview(rule: PiiRule, match: string): string {
  if (rule.severity === 'secret' || match.length <= 6) return '****';
  return `${match.slice(0, 2)}…${match.slice(-2)}`;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

interface RuleMatches {
  rule: PiiRule;
  finding: PiiFinding | null;
}

function collectRuleMatches(rule: PiiRule, text: string): RuleMatches {
  const regex = new RegExp(rule.pattern, 'g');
  let count = 0;
  let first: { index: number; match: string } | null = null;
  for (const hit of text.matchAll(regex)) {
    const match = hit[0];
    if (!matchIsReal(rule, match)) continue;
    count += 1;
    if (!first) first = { index: hit.index ?? 0, match };
  }
  if (!first) return { rule, finding: null };
  return {
    rule,
    finding: {
      rule_id: rule.id,
      severity: rule.severity,
      action: rule.action,
      match_preview: maskPreview(rule, first.match),
      line: lineOf(text, first.index),
      count,
    },
  };
}

/**
 * Scan without mutating: one finding per rule that matched, codepoint-sorted
 * by rule_id, with masked previews only.
 */
export function scanContent(text: string, options: PiiRuleOptions = {}): PiiScanResult {
  const rules = loadPiiRules(options);
  const findings: PiiFinding[] = [];
  const subject = String(text ?? '');
  for (const rule of rules) {
    const { finding } = collectRuleMatches(rule, subject);
    if (finding) findings.push(finding);
  }
  return { findings };
}

/** Locate matches for a caller that can redact a corresponding visual region. */
export function findPiiSpans(text: string, options: PiiRuleOptions = {}): PiiSpan[] {
  const spans: PiiSpan[] = [];
  for (const rule of loadPiiRules(options)) {
    const regex = new RegExp(rule.pattern, 'g');
    for (const hit of text.matchAll(regex)) {
      const value = hit[0];
      if (!matchIsReal(rule, value)) continue;
      const start = hit.index ?? 0;
      spans.push({
        start,
        end: start + value.length,
        rule_id: rule.id,
        severity: rule.severity,
        action: rule.action,
      });
    }
  }
  return spans.sort(
    (a, b) => a.start - b.start || a.end - b.end || a.rule_id.localeCompare(b.rule_id)
  );
}

/**
 * Scrub: every matching rule is masked to `[REDACTED:{rule_id}]` in
 * scrubbed_text (block-action matches too — raw sensitive text never leaves
 * even a blocked result). `blocked` is true when any block-action rule
 * matched and was not overridden; the caller must then refuse to persist.
 * Overridden block rules are downgraded to mask and reported in `applied`
 * with `overridden: true`.
 */
export function scrubContent(text: string, options: PiiScrubOptions = {}): PiiScrubResult {
  const rules = loadPiiRules(options);
  const overrides = new Set(
    (options.override_rule_ids ?? []).map((id) => String(id || '').trim()).filter(Boolean)
  );
  const subject = String(text ?? '');
  const applied: PiiScrubApplication[] = [];
  const blockReasons: string[] = [];
  let scrubbed = subject;
  for (const rule of rules) {
    const { finding } = collectRuleMatches(rule, scrubbed);
    if (!finding) continue;
    const overridden = rule.action === 'block' && overrides.has(rule.id);
    if (rule.action === 'block' && !overridden) {
      blockReasons.push(rule.id);
    } else {
      applied.push({ rule_id: rule.id, count: finding.count, overridden });
    }
    // Mask unconditionally: even blocked matches must not survive in the
    // returned text (defense in depth — callers may log scrubbed_text).
    const regex = new RegExp(rule.pattern, 'g');
    scrubbed = scrubbed.replace(regex, (match) =>
      matchIsReal(rule, match) ? `[REDACTED:${rule.id}]` : match
    );
  }
  return {
    scrubbed_text: scrubbed,
    applied,
    blocked: blockReasons.length > 0,
    block_reasons: codepointSort(blockReasons),
  };
}
