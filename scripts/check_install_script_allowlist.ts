/** PI-12: ensure pnpm build-script policy and its reasons cannot drift. */
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

type AllowlistEntry = { allow: boolean; reason: string };
type AllowlistFile = { schema_version: number; packages: Record<string, AllowlistEntry> };

function readJson<T>(relativePath: string): T {
  return JSON.parse(
    String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }))
  ) as T;
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

const workspace = String(
  safeReadFile(pathResolver.rootResolve('pnpm-workspace.yaml'), { encoding: 'utf8' })
);
const allowBuilds = parseAllowBuildsYaml(workspace);
const policy = readJson<AllowlistFile>(
  'knowledge/product/governance/install-script-allowlist.json'
);
const findings: string[] = [];

if (policy.schema_version !== 1) findings.push('unsupported allowlist schema_version');
for (const [packageName, entry] of Object.entries(policy.packages || {})) {
  if (typeof entry.allow !== 'boolean') findings.push(`${packageName}: allow must be boolean`);
  if (typeof entry.reason !== 'string' || entry.reason.trim().length < 12) {
    findings.push(`${packageName}: reason must be a meaningful non-empty string`);
  }
  if (!(packageName in allowBuilds)) {
    findings.push(`${packageName}: policy entry is not present in pnpm-workspace.yaml allowBuilds`);
  } else if (allowBuilds[packageName] !== entry.allow) {
    findings.push(`${packageName}: allowBuilds value differs from governance policy`);
  }
}
for (const packageName of Object.keys(allowBuilds)) {
  if (!(packageName in (policy.packages || {}))) {
    findings.push(`${packageName}: pnpm allowBuilds entry has no governance reason`);
  }
}

if (findings.length > 0) {
  console.error('[check:install-script-allowlist] FAILED');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`[check:install-script-allowlist] OK (${Object.keys(allowBuilds).length} packages)`);
}
