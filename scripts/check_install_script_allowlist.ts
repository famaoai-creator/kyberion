/** PI-12: ensure pnpm build-script policy and its reasons cannot drift. */
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { readSafeJsonFile } from './lib/json-input.js';

type AllowlistEntry = { allow: boolean; reason: string };
type AllowlistFile = { schema_version: number; packages: Record<string, AllowlistEntry> };

export function readWorkspaceTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error('pnpm-workspace.yaml must be a regular file');
  }
  return readTextFile(filePath);
}

function parseAllowBuildsYaml(source: string): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  const lines = source.split(/\r?\n/u);
  let inSection = false;
  for (const line of lines) {
    if (/^allowBuilds:\s*$/u.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && line.length > 0 && !/^\s{2}/u.test(line)) break;
    if (!inSection) continue;
    const match = line.match(/^\s{2}(?:'([^']+)'|"([^"]+)"|([^:#]+)):\s*(true|false)\s*$/u);
    if (!match) continue;
    const packageName = (match[1] || match[2] || match[3] || '').trim();
    if (packageName) result[packageName] = match[4] === 'true';
  }
  return result;
}

export function checkInstallScriptAllowlist(): {
  findings: string[];
  packageCount: number;
} {
  const workspace = readWorkspaceTextFile(pathResolver.rootResolve('pnpm-workspace.yaml'));
  const allowBuilds = parseAllowBuildsYaml(workspace);
  const policy = readSafeJsonFile<AllowlistFile>(
    pathResolver.rootResolve('knowledge/product/governance/install-script-allowlist.json'),
    'install-script allowlist'
  );
  const findings: string[] = [];

  if (policy.schema_version !== 1) findings.push('unsupported allowlist schema_version');
  for (const [packageName, entry] of Object.entries(policy.packages || {})) {
    if (typeof entry.allow !== 'boolean') findings.push(`${packageName}: allow must be boolean`);
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 12) {
      findings.push(`${packageName}: reason must be a meaningful non-empty string`);
    }
    if (!(packageName in allowBuilds)) {
      findings.push(
        `${packageName}: policy entry is not present in pnpm-workspace.yaml allowBuilds`
      );
    } else if (allowBuilds[packageName] !== entry.allow) {
      findings.push(`${packageName}: allowBuilds value differs from governance policy`);
    }
  }
  for (const packageName of Object.keys(allowBuilds)) {
    if (!(packageName in (policy.packages || {}))) {
      findings.push(`${packageName}: pnpm allowBuilds entry has no governance reason`);
    }
  }

  return { findings, packageCount: Object.keys(allowBuilds).length };
}

export const runCheckInstallScriptAllowlist = defineScript({
  name: 'check:install-script-allowlist',
  flags: [],
  run(context) {
    const result = checkInstallScriptAllowlist();
    if (result.findings.length > 0) {
      context.print('[check:install-script-allowlist] FAILED');
      for (const finding of result.findings) context.print(`- ${finding}`);
      throw new ScriptExitError(1);
    }
    context.print(`[check:install-script-allowlist] OK (${result.packageCount} packages)`);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'check_install_script_allowlist.ts') ||
  isDirectScript(import.meta.url, 'check_install_script_allowlist.js')
)
  void runCheckInstallScriptAllowlist();
