import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';

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

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|`([^`]*)`|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (token) tokens.push(token.replace(/\\(["'`\\])/g, '$1'));
  }
  return tokens;
}

function resolveExecutable(tokens: string[]): { executable: string; args: string[] } {
  const filtered = tokens.filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token));
  const executable = filtered[0] ? path.basename(filtered[0]) : '';
  return { executable, args: filtered.slice(1) };
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
    const matched = rule.command_regex.some((pattern) => {
      try {
        return new RegExp(pattern).test(command);
      } catch {
        return false;
      }
    });
    if (!matched) return false;
  }
  if (rule.arg_contains?.length && !rule.arg_contains.some((part) => args.join(' ').includes(part)))
    return false;
  if (rule.arg_regex?.length) {
    const argText = args.join(' ');
    const matched = rule.arg_regex.some((pattern) => {
      try {
        return new RegExp(pattern).test(argText);
      } catch {
        return false;
      }
    });
    if (!matched) return false;
  }
  return true;
}

function resolveReason(rule: ShellCommandPolicyRule | undefined, fallback: string): string {
  return rule?.reason?.trim() || fallback;
}

export function evaluateShellCommandPolicy(
  command: string,
  policy: ShellCommandPolicyFile = loadShellCommandPolicy()
): ShellCommandPolicyDecision {
  const normalized = String(command || '')
    .trim()
    .replace(/\s+/g, ' ');
  const tokens = tokenizeCommand(normalized);
  const { executable, args } = resolveExecutable(tokens);
  const denyRule = (policy.denylist || []).find((rule) =>
    matchesRule(rule, normalized, executable, args)
  );
  if (denyRule) {
    return {
      verdict: 'deny',
      command: normalized,
      executable,
      args,
      matchedRuleId: denyRule.id,
      reason: resolveReason(
        denyRule,
        policy.defaults?.deny_message || 'Denied by shell command policy.'
      ),
    };
  }

  const allowRule = (policy.allowlist || []).find((rule) =>
    matchesRule(rule, normalized, executable, args)
  );
  if (allowRule) {
    return {
      verdict: 'allow',
      command: normalized,
      executable,
      args,
      matchedRuleId: allowRule.id,
      reason: resolveReason(allowRule, 'Allowed by shell command policy.'),
    };
  }

  return {
    verdict: 'require_approval',
    command: normalized,
    executable,
    args,
    reason:
      policy.defaults?.require_approval_message ||
      'Shell command requires approval under Kyberion governance.',
  };
}
