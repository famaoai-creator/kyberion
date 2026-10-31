/**
 * libs/core/daemon/installed-units.ts — what this host actually has installed.
 *
 * The service managers (launchd.ts / systemd-user.ts / windows-task-scheduler.ts)
 * are pure planners; this module is the read side: it lists the per-user
 * Kyberion units already registered with the host service manager, tells
 * checkout-scoped units (`com.kyberion.<id>.ws-<hash>`) from legacy global ones
 * (`com.kyberion.<id>`), resolves which checkout each unit runs, and whether it
 * belongs to THIS checkout. Consumers: `pnpm kyberion scheduler reconcile`,
 * the setup report, and ops-health.
 *
 * Inspection never mutates the host. Unit files live outside the secure-io read
 * roots (~/Library/LaunchAgents, ~/.config/systemd/user), so they are listed and
 * read through the governed exec seam (`safeExecResult`), the same seam the
 * installer uses for `cp` / `launchctl`. Every host touch is injectable.
 */
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeExecResult } from '../secure-io.js';
import { daemonInstanceFromCanonicalRoot, resolveDaemonInstance } from './specs.js';

export interface InstalledUnit {
  id: string;
  label: string;
  scope: 'legacy' | 'scoped';
  repoRoot: string | null;
  ownedByThisCheckout: boolean;
  loaded: boolean | null;
}

export interface InstalledUnitsReport {
  platform: 'darwin' | 'linux' | 'win32' | 'unsupported';
  instanceId: string;
  repoRoot: string;
  units: InstalledUnit[];
  /** Present when the platform is not inspected (units is then empty). */
  note?: string;
}

/** Governed exec result shape (subset of safeExecResult). */
export interface InstalledUnitsExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type InstalledUnitsExec = (command: string, args: string[]) => InstalledUnitsExecResult;

export interface InspectInstalledUnitsOptions {
  /** Checkout root to compare against (default: pathResolver.rootDir()). */
  repoRoot?: string;
  /** Governed exec seam (default: safeExecResult with a short timeout). */
  exec?: InstalledUnitsExec;
  /** List file names in a unit directory; [] when missing (default: `ls -1` via exec). */
  listDir?: (dir: string) => string[];
  /** Read a unit file's text; null when unreadable (default: `cat` via exec). */
  readFile?: (file: string) => string | null;
  /** Test seam for the host platform. */
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: string;
  /** Probe the manager for load state (default true); false reports loaded: null. */
  probeLoaded?: boolean;
  /** Canonicalize the checkout root (default: safeRealpath through resolveDaemonInstance). */
  canonicalize?: (root: string) => string;
}

/** InstalledUnit plus the raw facts the reconcile planner compares. */
export interface InstalledUnitDetail extends InstalledUnit {
  /** Absolute unit file path. */
  unitPath: string;
  /** Drift hash of the installed unit text (unitDriftSha256, PATH masked); null when unreadable. */
  unitSha256: string | null;
  /** Interpreter the unit launches (ProgramArguments[0] / ExecStart argv0). */
  nodePath: string | null;
  /** Unit environment (EnvironmentVariables / Environment=), PATH included. */
  environment: Record<string, string>;
  /** Instance id carried in a scoped label. */
  instanceId: string | null;
}

export interface InstalledUnitDetailsReport extends Omit<InstalledUnitsReport, 'units'> {
  units: InstalledUnitDetail[];
}

const LABEL_RE = /^com\.kyberion\.([a-z0-9][a-z0-9-]*?)(?:\.(ws-[a-f0-9]{16}))?$/;
const SYSTEMD_STEM_RE = /^kyberion-([a-z0-9][a-z0-9-]*?)(?:-(ws-[a-f0-9]{16}))?$/;

function defaultExec(command: string, args: string[]): InstalledUnitsExecResult {
  const result = safeExecResult(command, args, { timeoutMs: 10_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Parse a launchd label into daemon id + optional checkout instance. */
export function parseKyberionUnitLabel(
  label: string
): { id: string; instanceId: string | null } | null {
  const match = LABEL_RE.exec(label);
  return match ? { id: match[1]!, instanceId: match[2] ?? null } : null;
}

// ---------------------------------------------------------------------------
// Minimal XML plist reader — enough for LaunchAgent dicts (dict/array/string/
// integer/real/true/false/data/date). Pure, so fixtures need no plutil.
// ---------------------------------------------------------------------------

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

/**
 * Single-pass tokenizer: tags and text runs, dropping the XML declaration,
 * processing instructions, comments and DOCTYPE. Uses indexOf only, so it is
 * linear in the input and never leaves a partial `<!--` behind.
 */
function tokenizePlistXml(xml: string): string[] {
  const tokens: string[] = [];
  let pos = 0;
  while (pos < xml.length) {
    const lt = xml.indexOf('<', pos);
    if (lt === -1) {
      tokens.push(xml.slice(pos));
      break;
    }
    if (lt > pos) tokens.push(xml.slice(pos, lt));
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      pos = end === -1 ? xml.length : end + 3;
      continue;
    }
    const gt = xml.indexOf('>', lt + 1);
    if (gt === -1) break;
    const tag = xml.slice(lt, gt + 1);
    if (!tag.startsWith('<?') && !tag.startsWith('<!')) tokens.push(tag);
    pos = gt + 1;
  }
  return tokens;
}

export function parsePlistXml(xml: string): Record<string, PlistValue> | null {
  const tokens = tokenizePlistXml(xml);
  if (tokens.length === 0) return null;
  let index = 0;
  const next = (): string | undefined => {
    while (index < tokens.length && !tokens[index]!.startsWith('<') && !tokens[index]!.trim())
      index += 1;
    return tokens[index++];
  };
  const textUntil = (close: string): string => {
    let text = '';
    while (index < tokens.length && tokens[index] !== close) text += tokens[index++];
    index += 1; // consume close tag
    return decodeXml(text);
  };
  const readValue = (open: string): PlistValue => {
    if (open === '<true/>') return true;
    if (open === '<false/>') return false;
    if (open === '<string/>') return '';
    if (open === '<dict/>') return {};
    if (open === '<array/>') return [];
    const tag = /^<([a-z]+)>$/.exec(open)?.[1];
    if (!tag) throw new Error(`unexpected plist token ${open}`);
    if (tag === 'string' || tag === 'data' || tag === 'date') return textUntil(`</${tag}>`);
    if (tag === 'integer' || tag === 'real') return Number(textUntil(`</${tag}>`).trim());
    if (tag === 'array') {
      const items: PlistValue[] = [];
      for (let token = next(); token !== '</array>'; token = next()) {
        if (token === undefined) throw new Error('unterminated array');
        items.push(readValue(token));
      }
      return items;
    }
    if (tag === 'dict') {
      const dict: Record<string, PlistValue> = {};
      for (let token = next(); token !== '</dict>'; token = next()) {
        if (token !== '<key>') throw new Error(`expected <key>, got ${token}`);
        const key = textUntil('</key>');
        const valueToken = next();
        if (valueToken === undefined) throw new Error('missing value');
        dict[key] = readValue(valueToken);
      }
      return dict;
    }
    throw new Error(`unsupported plist tag ${tag}`);
  };
  try {
    let token = next();
    if (token?.startsWith('<plist')) token = next();
    if (token === undefined) return null;
    const value = readValue(token);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Checkout root a unit runs: WorkingDirectory → KYBERION_ROOT → script path before /dist/. */
export function deriveUnitRepoRoot(input: {
  workingDirectory?: string | null;
  environment?: Record<string, string>;
  programArguments?: string[];
}): string | null {
  const candidates = [input.workingDirectory, input.environment?.KYBERION_ROOT];
  for (const candidate of candidates) {
    if (candidate && candidate.startsWith('/')) return trimTrailingSlash(candidate);
  }
  for (const arg of input.programArguments ?? []) {
    const marker = arg.lastIndexOf('/dist/');
    if (marker > 0 && arg.startsWith('/')) return trimTrailingSlash(arg.slice(0, marker));
    const scripts = arg.lastIndexOf('/scripts/');
    if (scripts > 0 && arg.startsWith('/') && /\.(?:[cm]?js|ts)$/.test(arg))
      return trimTrailingSlash(arg.slice(0, scripts));
  }
  return null;
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 1 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

function stringRecord(value: PlistValue | undefined): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Unit text with the baked PATH value masked (launchd `EnvironmentVariables`
 * PATH string, systemd `Environment=PATH=` line). PATH is derived from the
 * installing shell (daemonUserPath), so two shells render different text for
 * the same install; drift detection hashes this form so reconcile never
 * reinstalls on a PATH difference alone. `scheduler install --apply` still
 * re-renders PATH on demand.
 */
export function maskUnitPathValue(text: string): string {
  return text
    .replace(/(<key>PATH<\/key>\s*<string>)[^<]*(<\/string>)/u, '$1*$2')
    .replace(/^Environment="?PATH=.*$/mu, 'Environment=PATH=*');
}

/** Drift hash of a unit: sha256 of its text with the PATH value masked. */
export function unitDriftSha256(text: string): string {
  return sha256(maskUnitPathValue(text));
}

interface InspectContext {
  exec: InstalledUnitsExec;
  listDir: (dir: string) => string[];
  readFile: (file: string) => string | null;
  homeDir: string;
  uid: string | null;
  probeLoaded: boolean;
  instanceId: string;
  repoRoot: string;
  platform: NodeJS.Platform;
}

/** Same checkout? Scoped units compare instance ids; legacy units compare roots. */
function ownedBy(ctx: InspectContext, instanceId: string | null, repoRoot: string | null): boolean {
  if (instanceId) return instanceId === ctx.instanceId;
  if (!repoRoot) return false;
  if (repoRoot === ctx.repoRoot) return true;
  try {
    return daemonInstanceFromCanonicalRoot(repoRoot, ctx.platform).id === ctx.instanceId;
  } catch {
    return false;
  }
}

function inspectDarwin(ctx: InspectContext): InstalledUnitDetail[] {
  const dir = path.posix.join(ctx.homeDir, 'Library/LaunchAgents');
  const units: InstalledUnitDetail[] = [];
  for (const name of [...ctx.listDir(dir)].sort()) {
    if (!/^com\.kyberion\..+\.plist$/.test(name)) continue;
    const unitPath = path.posix.join(dir, name);
    const text = ctx.readFile(unitPath);
    const plist = text === null ? null : parsePlistXml(text);
    const label =
      typeof plist?.Label === 'string' && plist.Label
        ? plist.Label
        : name.slice(0, -'.plist'.length);
    const parsed = parseKyberionUnitLabel(label);
    if (!parsed) continue;
    const programArguments = Array.isArray(plist?.ProgramArguments)
      ? plist.ProgramArguments.filter((arg): arg is string => typeof arg === 'string')
      : typeof plist?.Program === 'string'
        ? [plist.Program]
        : [];
    const environment = stringRecord(plist?.EnvironmentVariables);
    const repoRoot = deriveUnitRepoRoot({
      workingDirectory: typeof plist?.WorkingDirectory === 'string' ? plist.WorkingDirectory : null,
      environment,
      programArguments,
    });
    let loaded: boolean | null = null;
    if (ctx.probeLoaded && ctx.uid) {
      try {
        const result = ctx.exec('launchctl', ['print', `gui/${ctx.uid}/${label}`]);
        loaded = result.status === null ? null : result.status === 0;
      } catch {
        loaded = null;
      }
    }
    units.push({
      id: parsed.id,
      label,
      scope: parsed.instanceId ? 'scoped' : 'legacy',
      repoRoot,
      ownedByThisCheckout: ownedBy(ctx, parsed.instanceId, repoRoot),
      loaded,
      unitPath,
      unitSha256: text === null ? null : unitDriftSha256(text),
      nodePath: programArguments[0] ?? null,
      environment,
      instanceId: parsed.instanceId,
    });
  }
  return units;
}

/** Split one systemd directive value into words (handles "quoted words"). */
function systemdWords(value: string): string[] {
  const words: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|(\S+)/g;
  for (let match = re.exec(value); match; match = re.exec(value)) {
    words.push(
      match[1] !== undefined
        ? match[1].replace(/\\(.)/g, '$1').replaceAll('%%', '%').replaceAll('$$', '$')
        : match[2]!.replaceAll('%%', '%').replaceAll('$$', '$')
    );
  }
  return words;
}

function inspectLinux(ctx: InspectContext): InstalledUnitDetail[] {
  const dir = path.posix.join(ctx.homeDir, '.config/systemd/user');
  const names = [...ctx.listDir(dir)].sort();
  const units: InstalledUnitDetail[] = [];
  for (const name of names) {
    if (!/^kyberion-.+\.service$/.test(name)) continue;
    const stem = name.slice(0, -'.service'.length);
    const parsed = SYSTEMD_STEM_RE.exec(stem);
    if (!parsed) continue;
    const id = parsed[1]!;
    const instanceId = parsed[2] ?? null;
    const unitPath = path.posix.join(dir, name);
    const text = ctx.readFile(unitPath);
    const environment: Record<string, string> = {};
    let workingDirectory: string | null = null;
    let execStart: string[] = [];
    for (const line of (text ?? '').split(/\r?\n/)) {
      const directive = /^([A-Za-z]+)=(.*)$/.exec(line.trim());
      if (!directive) continue;
      const [, key, value] = directive;
      if (key === 'WorkingDirectory') workingDirectory = value!.replaceAll('%%', '%');
      else if (key === 'Environment') {
        for (const word of systemdWords(value!)) {
          const eq = word.indexOf('=');
          if (eq > 0) environment[word.slice(0, eq)] = word.slice(eq + 1);
        }
      } else if (key === 'ExecStart') execStart = systemdWords(value!);
    }
    const repoRoot = deriveUnitRepoRoot({
      workingDirectory,
      environment,
      programArguments: execStart,
    });
    const timer = names.includes(`${stem}.timer`);
    let loaded: boolean | null = null;
    if (ctx.probeLoaded) {
      try {
        const result = ctx.exec('systemctl', [
          '--user',
          'is-enabled',
          `${stem}.${timer ? 'timer' : 'service'}`,
        ]);
        loaded = result.status === null ? null : result.status === 0;
      } catch {
        loaded = null;
      }
    }
    units.push({
      id,
      label: `com.kyberion.${id}${instanceId ? `.${instanceId}` : ''}`,
      scope: instanceId ? 'scoped' : 'legacy',
      repoRoot,
      ownedByThisCheckout: ownedBy(ctx, instanceId, repoRoot),
      loaded,
      unitPath,
      unitSha256: text === null ? null : unitDriftSha256(text),
      nodePath: execStart[0] ?? null,
      environment,
      instanceId,
    });
  }
  return units;
}

function reportPlatform(platform: NodeJS.Platform): InstalledUnitsReport['platform'] {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32'
    ? platform
    : 'unsupported';
}

/** Full detail (unit hash, node path, environment) for the reconcile planner. */
export function inspectInstalledUnitDetails(
  options: InspectInstalledUnitsOptions = {}
): InstalledUnitDetailsReport {
  const platform = options.platform ?? process.platform;
  const instance = resolveDaemonInstance(
    options.repoRoot ?? pathResolver.rootDir(),
    options.canonicalize,
    platform
  );
  const exec = options.exec ?? defaultExec;
  const ctx: InspectContext = {
    exec,
    listDir:
      options.listDir ??
      ((dir) => {
        try {
          const result = exec('ls', ['-1', dir]);
          return result.status === 0 ? result.stdout.split('\n').filter(Boolean) : [];
        } catch {
          return [];
        }
      }),
    readFile:
      options.readFile ??
      ((file) => {
        try {
          const result = exec('cat', [file]);
          return result.status === 0 ? result.stdout : null;
        } catch {
          return null;
        }
      }),
    homeDir: options.homeDir ?? os.homedir(),
    uid: options.uid ?? (typeof process.getuid === 'function' ? String(process.getuid()) : null),
    probeLoaded: options.probeLoaded !== false,
    instanceId: instance.id,
    repoRoot: instance.repoRoot,
    platform,
  };
  const base = {
    platform: reportPlatform(platform),
    instanceId: instance.id,
    repoRoot: instance.repoRoot,
  };
  if (platform === 'darwin') return { ...base, units: inspectDarwin(ctx) };
  if (platform === 'linux') return { ...base, units: inspectLinux(ctx) };
  return {
    ...base,
    units: [],
    note:
      platform === 'win32'
        ? 'Task Scheduler units are not inspected yet — use `pnpm kyberion scheduler status --daemon <id>`'
        : `no user-level service manager for platform '${platform}'`,
  };
}

/** The contract: which Kyberion units this host has, and which belong to this checkout. */
export function inspectInstalledUnits(
  options: InspectInstalledUnitsOptions = {}
): InstalledUnitsReport {
  const detail = inspectInstalledUnitDetails(options);
  return {
    platform: detail.platform,
    instanceId: detail.instanceId,
    repoRoot: detail.repoRoot,
    units: detail.units.map(({ id, label, scope, repoRoot, ownedByThisCheckout, loaded }) => ({
      id,
      label,
      scope,
      repoRoot,
      ownedByThisCheckout,
      loaded,
    })),
    ...(detail.note ? { note: detail.note } : {}),
  };
}
