import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, vi } from 'vitest';
function testPath(filePath: string): string {
  return path.isAbsolute(filePath)
    ? filePath
    : path.join(process.env.KYBERION_ROOT || process.cwd(), filePath);
}

async function installTestIoSeams(): Promise<void> {
  const lockIo = {
    exists: (filePath: string): boolean => fs.existsSync(testPath(filePath)),
    mkdir: (dirPath: string): void => fs.mkdirSync(testPath(dirPath), { recursive: true }),
    createExclusive: (filePath: string, content: string): void => {
      const resolved = testPath(filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, { encoding: 'utf8', flag: 'wx' });
    },
    unlink: (filePath: string): void => fs.unlinkSync(testPath(filePath)),
    loadJson: <T>(filePath: string): T =>
      JSON.parse(fs.readFileSync(testPath(filePath), 'utf8')) as T,
  };
  const chainIo = {
    exists: (filePath: string): boolean => fs.existsSync(testPath(filePath)),
    read: (filePath: string): string => fs.readFileSync(testPath(filePath), 'utf8'),
    mkdir: (dirPath: string): void => fs.mkdirSync(testPath(dirPath), { recursive: true }),
    createExclusive: (filePath: string, content: string): void => {
      const resolved = testPath(filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, { encoding: 'utf8', flag: 'wx' });
    },
    chmod: (filePath: string, mode: number): void => fs.chmodSync(testPath(filePath), mode),
  };
  const auditIo = {
    read: (filePath: string): string => fs.readFileSync(testPath(filePath), 'utf8'),
    loadJson: <T>(filePath: string): T =>
      JSON.parse(fs.readFileSync(testPath(filePath), 'utf8')) as T,
    exists: (filePath: string): boolean => fs.existsSync(testPath(filePath)),
    mkdir: (dirPath: string): void => fs.mkdirSync(testPath(dirPath), { recursive: true }),
    readdir: (dirPath: string): string[] => fs.readdirSync(testPath(dirPath)),
    append: (filePath: string, content: string): void => {
      const resolved = testPath(filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.appendFileSync(resolved, content, 'utf8');
    },
  };
  // Foundation JSON is never globally replaced by a raw filesystem adapter.
  // Production foundation imports bootstrap secure-io; isolated suites own an
  // explicit, path-confined FoundationIo fixture in that suite.
  (globalThis as typeof globalThis & { __kyberionVitestIo?: unknown }).__kyberionVitestIo = {
    lockIo,
    chainIo,
    auditIo,
  };
}

// Lock/chain/audit test seams remain explicit because those modules expose
// narrow test adapters. Foundation JSON always uses the real secure-io bridge.
beforeEach(async () => installTestIoSeams());

export interface VitestNetworkEgressAttempt {
  origin: string;
  method: string;
  hostname: string;
  port: string;
}

interface NetworkEndpoint {
  protocol: string;
  hostname: string;
  port: string;
  origin: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const originalFetch = globalThis.fetch;
const originalHttpRequest = http.request as (...args: any[]) => any;
const originalHttpGet = http.get as (...args: any[]) => any;
const originalHttpsRequest = https.request as (...args: any[]) => any;
const originalHttpsGet = https.get as (...args: any[]) => any;
const unexpectedAttempts: VitestNetworkEgressAttempt[] = [];

function defaultPort(protocol: string): string {
  return protocol === 'https:' ? '443' : '80';
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

function endpointFromUrl(value: string | URL): NetworkEndpoint | undefined {
  try {
    const parsed = new URL(value.toString());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return {
      protocol: parsed.protocol,
      hostname: normalizeHostname(parsed.hostname),
      port: parsed.port || defaultPort(parsed.protocol),
      origin: parsed.origin,
    };
  } catch {
    return undefined;
  }
}

function endpointKey(endpoint: Pick<NetworkEndpoint, 'hostname' | 'port'>): string {
  return `${endpoint.hostname}:${endpoint.port}`;
}

function hasExplicitPort(token: string): boolean {
  const authority = token.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').split(/[/?#]/, 1)[0];
  if (authority.startsWith('[')) return /^\[[^\]]+\]:\d+$/.test(authority);
  return /:\d+$/.test(authority);
}

function allowedEndpoints(): Set<string> {
  const endpoints = new Set<string>();
  for (const token of String(process.env.KYBERION_VITEST_NETWORK_ALLOWLIST || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)) {
    if (!hasExplicitPort(token)) {
      throw new Error(
        `[POLICY_VIOLATION] Vitest network allowlist entries require an explicit port: ${token}`
      );
    }
    const parsed = endpointFromUrl(token.includes('://') ? token : `http://${token}`);
    if (!parsed) {
      throw new Error(`[POLICY_VIOLATION] Invalid Vitest network allowlist entry: ${token}`);
    }
    endpoints.add(endpointKey(parsed));
  }
  return endpoints;
}

function isAllowedEndpoint(endpoint: NetworkEndpoint): boolean {
  return LOCAL_HOSTS.has(endpoint.hostname) || allowedEndpoints().has(endpointKey(endpoint));
}

function rejectUnexpected(endpoint: NetworkEndpoint | undefined, method: string): Error {
  const attempt = {
    origin: endpoint?.origin || '[unknown-origin]',
    method,
    hostname: endpoint?.hostname || '[unknown-host]',
    port: endpoint?.port || '[unknown-port]',
  };
  unexpectedAttempts.push(attempt);
  return new Error(
    `[POLICY_VIOLATION] Vitest network egress denied: ${attempt.hostname}:${attempt.port} (${method})`
  );
}

function nodeRequestEndpoint(
  protocolHint: string,
  input: unknown,
  options: Record<string, unknown> | undefined
): NetworkEndpoint | undefined {
  if (typeof input === 'string' || input instanceof URL) {
    const endpoint = endpointFromUrl(input);
    if (!endpoint) return undefined;
    if (options?.port !== undefined) endpoint.port = String(options.port);
    return endpoint;
  }

  if (!input || typeof input !== 'object') return undefined;
  const requestOptions = input as Record<string, unknown>;
  const protocol = String(requestOptions.protocol || protocolHint);
  const hostname = normalizeHostname(
    String(requestOptions.hostname || requestOptions.host || 'localhost')
  );
  const port = String(requestOptions.port || defaultPort(protocol));
  return {
    protocol,
    hostname,
    port,
    origin: `${protocol}//${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`,
  };
}

function guardedNodeRequest(
  protocolHint: string,
  original: (...args: any[]) => any,
  owner: object,
  args: any[]
): any {
  const input = args[0];
  const optionCandidate = args[1];
  const options =
    optionCandidate && typeof optionCandidate === 'object' && !(optionCandidate instanceof URL)
      ? (optionCandidate as Record<string, unknown>)
      : input && typeof input === 'object' && !(input instanceof URL)
        ? (input as Record<string, unknown>)
        : undefined;
  const endpoint = nodeRequestEndpoint(protocolHint, input, options);
  const method = String(options?.method || 'GET').toUpperCase();
  if (!endpoint || !isAllowedEndpoint(endpoint)) {
    throw rejectUnexpected(endpoint, method);
  }
  return Reflect.apply(original, owner, args);
}

function replaceBuiltinFunction(
  module: Record<string, unknown>,
  name: string,
  replacement: (...args: any[]) => any
): void {
  Object.defineProperty(module, name, {
    configurable: true,
    writable: true,
    value: replacement,
  });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const endpoint = endpointFromUrl(rawUrl);
  const method = String(
    init?.method || (input instanceof Request ? input.method : 'GET')
  ).toUpperCase();
  if (!endpoint || !isAllowedEndpoint(endpoint)) {
    throw rejectUnexpected(endpoint, method);
  }
  return originalFetch(input, init);
}) as typeof fetch;

replaceBuiltinFunction(http as unknown as Record<string, unknown>, 'request', function (...args) {
  return guardedNodeRequest('http:', originalHttpRequest, http, args);
});
replaceBuiltinFunction(http as unknown as Record<string, unknown>, 'get', function (...args) {
  return guardedNodeRequest('http:', originalHttpGet, http, args);
});
replaceBuiltinFunction(https as unknown as Record<string, unknown>, 'request', function (...args) {
  return guardedNodeRequest('https:', originalHttpsRequest, https, args);
});
replaceBuiltinFunction(https as unknown as Record<string, unknown>, 'get', function (...args) {
  return guardedNodeRequest('https:', originalHttpsGet, https, args);
});
syncBuiltinESMExports();

export function isVitestNetworkEndpointAllowed(value: string | URL): boolean {
  const endpoint = endpointFromUrl(value);
  return endpoint !== undefined && isAllowedEndpoint(endpoint);
}

export function getVitestNetworkEgressAttempts(): VitestNetworkEgressAttempt[] {
  return unexpectedAttempts.map((attempt) => ({ ...attempt }));
}

export function clearVitestNetworkEgressAttempts(): void {
  unexpectedAttempts.length = 0;
}

afterAll(() => {
  globalThis.fetch = originalFetch;
  replaceBuiltinFunction(
    http as unknown as Record<string, unknown>,
    'request',
    originalHttpRequest
  );
  replaceBuiltinFunction(http as unknown as Record<string, unknown>, 'get', originalHttpGet);
  replaceBuiltinFunction(
    https as unknown as Record<string, unknown>,
    'request',
    originalHttpsRequest
  );
  replaceBuiltinFunction(https as unknown as Record<string, unknown>, 'get', originalHttpsGet);
  syncBuiltinESMExports();
  if (unexpectedAttempts.length > 0) {
    throw new Error(
      `[POLICY_VIOLATION] Unhandled Vitest network egress: ${unexpectedAttempts
        .map((attempt) => `${attempt.method} ${attempt.origin}`)
        .join(', ')}`
    );
  }
});
