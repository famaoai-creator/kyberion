import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { isInjectionSuspected } from './untrusted-content.js';
import { findSensitivePathInText } from './sensitive-path-policy.js';
import {
  allowableCommands,
  compileSafeRegex,
  scannableUnits,
  simpleCommands,
  type AllowCandidate,
  type SimpleCommand,
} from './shell-command-normalize.js';
import { logger } from './core.js';

export type ShellCommandVerdict = 'allow' | 'deny' | 'require_approval';

export interface ShellCommandPolicyRule {
  id: string;
  executables?: string[];
  command_contains?: string[];
  command_regex?: string[];
  arg_contains?: string[];
  arg_regex?: string[];
  reason?: string;
}

export interface ShellCommandPolicyFile {
  version: string;
  defaults?: {
    require_approval_message?: string;
    deny_message?: string;
  };
  allowlist?: ShellCommandPolicyRule[];
  denylist?: ShellCommandPolicyRule[];
}

export interface ShellCommandPolicyDecision {
  verdict: ShellCommandVerdict;
  command: string;
  executable: string;
  args: string[];
  matchedRuleId?: string;
  reason: string;
}

const DEFAULT_POLICY_PATH = pathResolver.knowledge('product/governance/shell-command-policy.json');
let cachedPolicyPath: string | null = null;
let cachedPolicy: ShellCommandPolicyFile | null = null;

export function resetShellCommandPolicyCache(): void {
  cachedPolicyPath = null;
  cachedPolicy = null;
}

function getPolicyPath(): string {
  return process.env.KYBERION_SHELL_COMMAND_POLICY_PATH?.trim() || DEFAULT_POLICY_PATH;
}

export function loadShellCommandPolicy(): ShellCommandPolicyFile {
  const policyPath = getPolicyPath();
  if (cachedPolicy && cachedPolicyPath === policyPath) return cachedPolicy;
  if (!safeExistsSync(policyPath)) {
    cachedPolicyPath = policyPath;
    cachedPolicy = { version: 'missing-policy', allowlist: [], denylist: [] };
    return cachedPolicy;
  }
  const raw = safeReadFile(policyPath, { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(raw) as ShellCommandPolicyFile;
  cachedPolicyPath = policyPath;
  cachedPolicy = parsed;
  return parsed;
}

const regexCache = new Map<string, RegExp | null>();

function compiledRule(pattern: string): RegExp | null {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null;
  try {
    compiled = compileSafeRegex(pattern);
  } catch (error) {
    logger.warn(
      `[shell-command-policy] unsafe/invalid rule pattern ${JSON.stringify(pattern)}: ${
        error instanceof Error ? error.message : String(error)
      } — rewrite it without backreferences, lookarounds, or nested repetition.`
    );
    compiled = null;
  }
  regexCache.set(pattern, compiled);
  return compiled;
}

function safeRegexTest(pattern: string, text: string): boolean {
  return compiledRule(pattern)?.test(text) ?? false;
}

/**
 * Review finding (batch-1): an uncompilable DENY pattern must not fail open.
 * The rule can no longer block anything, so the whole policy degrades to
 * approval-only until the pattern is fixed.
 */
function hasBrokenPattern(rules: ShellCommandPolicyRule[]): string | undefined {
  for (const rule of rules) {
    for (const pattern of [...(rule.command_regex || []), ...(rule.arg_regex || [])]) {
      if (compiledRule(pattern) === null) return rule.id;
    }
  }
  return undefined;
}

function matchesRule(
  rule: ShellCommandPolicyRule,
  command: string,
  executable: string,
  args: string[]
): boolean {
  if (rule.executables?.length && !rule.executables.includes(executable)) return false;
  if (
    rule.command_contains?.length &&
    !rule.command_contains.some((part) => command.includes(part))
  )
    return false;
  if (rule.command_regex?.length) {
    if (!rule.command_regex.some((pattern) => safeRegexTest(pattern, command))) return false;
  }
  if (rule.arg_contains?.length && !rule.arg_contains.some((part) => args.join(' ').includes(part)))
    return false;
  if (rule.arg_regex?.length) {
    const argText = args.join(' ');
    if (!rule.arg_regex.some((pattern) => safeRegexTest(pattern, argText))) return false;
  }
  return true;
}

interface EvaluationUnit {
  text: string;
  commands: SimpleCommand[];
}

function matchesUnit(rule: ShellCommandPolicyRule, unit: EvaluationUnit): boolean {
  if (unit.commands.length === 0) return matchesRule(rule, unit.text, '', []);
  return unit.commands.some((cmd) =>
    matchesRule(rule, unit.text, path.basename(cmd.executable), cmd.args)
  );
}

function resolveReason(rule: ShellCommandPolicyRule | undefined, fallback: string): string {
  return rule?.reason?.trim() || fallback;
}

function commandText(cmd: SimpleCommand): string {
  return [cmd.executable, ...cmd.args].join(' ');
}

const MAX_COMMAND_SCAN_CHARS = 64_000;

/**
 * Asymmetric evaluation (batch-1 review):
 *  - DENY sees the union of every interpretation — the raw command text plus
 *    every de-obfuscated unit — so neither quoting nor wrapping can hide a
 *    payload from a deny rule or the sensitive-path check.
 *  - ALLOW sees only the original word sequence (allowableCommands), which
 *    refuses privilege wrappers, unsafe env assignments, write redirects and
 *    risky command arguments outright. De-obfuscation never creates an allow.
 */
export function evaluateShellCommandPolicy(
  command: string,
  policy: ShellCommandPolicyFile = loadShellCommandPolicy()
): ShellCommandPolicyDecision {
  const raw = String(command || '')
    .replace(/\r\n/g, '\n')
    .replace(/\\\n/g, ' ')
    .trim();
  const normalized = raw.replace(/\s+/g, ' ');
  const allowCandidates = allowableCommands(raw);
  const primary = allowCandidates?.[0];
  const executable = primary ? path.basename(primary.executable) : '';
  const args = primary?.args ?? [];
  const base = { command: normalized, executable, args };

  if (raw.length > MAX_COMMAND_SCAN_CHARS) {
    return {
      verdict: 'require_approval',
      ...base,
      reason: `Command exceeds ${MAX_COMMAND_SCAN_CHARS} chars and cannot be fully scanned; unscannable input requires approval.`,
    };
  }

  const denyTextSet = new Set<string>([normalized]);
  for (const unit of scannableUnits(raw)) denyTextSet.add(unit);
  const denyUnits: EvaluationUnit[] = [...denyTextSet].map((text) => ({
    text,
    commands: simpleCommands(text),
  }));

  for (const unit of denyUnits) {
    const sensitivePath = findSensitivePathInText(unit.text);
    if (sensitivePath) {
      return {
        verdict: 'deny',
        ...base,
        matchedRuleId: sensitivePath.ruleId,
        reason: `[SENSITIVE_PATH_DENIED] ${sensitivePath.description} is protected from shell access.`,
      };
    }
  }

  for (const unit of denyUnits) {
    const denyRule = (policy.denylist || []).find(
      (rule) =>
        matchesUnit(rule, unit) ||
        unit.commands.some((cmd) =>
          matchesRule(rule, commandText(cmd), path.basename(cmd.executable), cmd.args)
        )
    );
    if (denyRule) {
      return {
        verdict: 'deny',
        ...base,
        matchedRuleId: denyRule.id,
        reason: resolveReason(
          denyRule,
          policy.defaults?.deny_message || 'Denied by shell command policy.'
        ),
      };
    }
  }

  const brokenDenyRuleId = hasBrokenPattern(policy.denylist || []);
  if (brokenDenyRuleId) {
    return {
      verdict: 'require_approval',
      ...base,
      matchedRuleId: brokenDenyRuleId,
      reason: `Deny rule '${brokenDenyRuleId}' has an uncompilable pattern; the policy cannot fail open, so everything requires approval until it is fixed.`,
    };
  }

  const allowRules = policy.allowlist || [];
  const allowRuleFor = (candidate: AllowCandidate): ShellCommandPolicyRule | undefined =>
    allowRules.find((rule) =>
      matchesRule(rule, candidate.display, candidate.executable, candidate.args)
    );
  const everyCommandAllowed =
    allowCandidates !== null &&
    allowCandidates.length > 0 &&
    allowCandidates.every((candidate) => allowRuleFor(candidate));
  if (everyCommandAllowed) {
    const allowRule = allowRuleFor(primary!)!;
    if (isInjectionSuspected()) {
      return {
        verdict: 'require_approval',
        ...base,
        matchedRuleId: allowRule.id,
        reason: `Kyberion safety: Command normally allowed by '${allowRule.id}' requires approval due to suspected prompt injection in active context.`,
      };
    }
    return {
      verdict: 'allow',
      ...base,
      matchedRuleId: allowRule.id,
      reason: resolveReason(allowRule, 'Allowed by shell command policy.'),
    };
  }

  return {
    verdict: 'require_approval',
    ...base,
    reason:
      policy.defaults?.require_approval_message ||
      'Shell command requires approval under Kyberion governance.',
  };
}
