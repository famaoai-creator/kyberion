import {
  safeExecResult,
  safeExistsSync,
  safeStat,
  safeReadFile,
  assertSafeRepositoryPath,
} from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';
export type ProbeExec = typeof safeExecResult;
export interface ProviderProbe {
  name: string;
  command: string;
  version_args?: string[];
  ping_args?: string[];
  capability_marker?: string;
  capability_args?: string[];
  fallback_command?: string;
  fallback_args?: string[];
}
export function parseProviderProbe(value: unknown): ProviderProbe {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid provider probe');
  const fields = Object.fromEntries(Object.entries(value));
  const requiredString = (key: string): string => {
    const field = fields[key];
    if (typeof field !== 'string' || !field.trim() || field.includes('\0'))
      throw new Error('Invalid provider ' + key);
    return field;
  };
  const optionalString = (key: string): string | undefined =>
    fields[key] === undefined ? undefined : requiredString(key);
  const args = (key: string): string[] | undefined => {
    const field = fields[key];
    if (field === undefined) return undefined;
    if (!Array.isArray(field)) throw new Error('Invalid provider ' + key);
    return field.map((arg: unknown) => {
      if (typeof arg !== 'string' || arg.includes('\0'))
        throw new Error('Invalid provider argument');
      return arg;
    });
  };
  return {
    name: requiredString('name'),
    command: requiredString('command'),
    version_args: args('version_args'),
    ping_args: args('ping_args'),
    capability_marker: optionalString('capability_marker'),
    capability_args: args('capability_args'),
    fallback_command: optionalString('fallback_command'),
    fallback_args: args('fallback_args'),
  };
}
export function probeProvider(p: ProviderProbe, exec: ProbeExec = safeExecResult) {
  const version = exec(p.command, p.version_args ?? ['--version'], { timeoutMs: 5000 });
  const fallback =
    version.status !== 0 && p.fallback_command
      ? exec(p.fallback_command, p.fallback_args ?? ['--version'], { timeoutMs: 5000 })
      : undefined;
  const available = version.status === 0 || fallback?.status === 0;
  const ping =
    available && p.ping_args
      ? exec(p.command, p.ping_args, { timeoutMs: 30000, input: 'ping\n' })
      : undefined;
  const help =
    available && p.capability_marker
      ? exec(p.command, p.capability_args ?? ['--help'], { timeoutMs: 5000 })
      : undefined;
  return {
    name: p.name,
    install: available ? (version.status === 0 ? 'INSTALLED' : 'INSTALLED (npx)') : 'NOT_FOUND',
    version: version.status === 0 ? version.stdout.trim() : 'N/A',
    ping: ping?.status === 0 ? ping.stdout.split('\n')[0].trim() : 'FAILED',
    capability: help?.status === 0 && help.stdout.includes(p.capability_marker ?? ''),
  };
}
export function probeNarratedTools(exec: ProbeExec = safeExecResult) {
  const commands: Array<[string, string[]]> = [
    ['say', ['-v', '?']],
    ['espeak', ['--version']],
    ['ffmpeg', ['-version']],
    ['ffprobe', ['-version']],
  ];
  const tools = Object.fromEntries(
    commands.map(([command, args]) => {
      const r = exec(command, args, { timeoutMs: 5000 });
      return [command, { available: r.status === 0, status: r.status }];
    })
  );
  for (const command of ['ffmpeg', 'ffprobe']) {
    if (!tools[command].available)
      throw new Error('[NARRATED_REPORT_TOOL_REQUIRED] ' + command + ' is unavailable');
  }
  return tools;
}
export function validateAudioArtifact(audioPath: string, exec: ProbeExec = safeExecResult) {
  const target = assertSafeRepositoryPath(audioPath);
  if (!safeExistsSync(target) || !safeStat(target).isFile())
    throw new Error('Narration artifact is missing');
  const r = exec(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'csv:p=0',
      target,
    ],
    { timeoutMs: 10000 }
  );
  if (r.status !== 0 || !r.stdout.split(/\r?\n/).includes('audio'))
    throw new Error('Narration artifact has no valid audio stream');
  return r;
}
export function partitionSurfaceHealth(surfaces: unknown) {
  if (!Array.isArray(surfaces)) throw new Error('Surface health requires an array');
  const r: Record<'running' | 'zombies' | 'stopped', Record<string, unknown>[]> = {
    running: [],
    zombies: [],
    stopped: [],
  };
  for (const surface of surfaces) {
    if (!surface || typeof surface !== 'object') throw new Error('Invalid surface');
    const s = surface as Record<string, unknown>;
    r[s.running === true ? 'running' : s.enabled === true ? 'zombies' : 'stopped'].push(s);
  }
  return r;
}
export function collectSurfaceErrors() {
  const root = assertSafeRepositoryPath('active/shared/logs/surfaces', { allowMissingLeaf: true });
  if (!safeExistsSync(root)) return 'No recent surface errors';
  const lines: string[] = [];
  for (const file of getAllFiles(root).sort()) {
    const content = safeReadFile(assertSafeRepositoryPath(file), { encoding: 'utf8' }) as string;
    for (const line of content.split(/\r?\n/))
      if (line.includes('ERROR')) lines.push(file + ':' + line);
  }
  return lines.slice(-15).join('\n') || 'No recent surface errors';
}
