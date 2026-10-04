/**
 * Public ingress provider: Tailscale Funnel (CLI adapter).
 *
 * Publishes one loopback surface at https://<node>.<tailnet>.ts.net<prefix>
 * through `tailscale funnel --bg`. Only the surface's own path mapping is
 * touched: `up` refuses a prefix already mapped to another target and refuses
 * to switch Funnel on for a port whose other (tailnet-only) mappings would
 * become public as a side effect; `down` removes only that mapping.
 *
 * Command construction and JSON parsing are pure, exported functions so they
 * are unit-tested without a Tailscale install; the command runner is an
 * injectable port defaulting to the governed safeExecResultAsync.
 */
import { safeExecResultAsync } from '../../secure-io.js';
import { parseSafeJsonInput } from '../../foundation/safe-json.js';
import { isRecord } from '../../foundation/text.js';
import { resolveTailscaleBin } from '../../tool/tool-binary-resolvers.js';
import {
  IngressError,
  assertIngressLocalPort,
  ingressLoopbackTarget,
  joinIngressPublicUrl,
  normalizeIngressPathPrefix,
  type IngressExposure,
  type IngressReadiness,
  type IngressTargetRequest,
  type IngressUpRequest,
  type PublicIngressProvider,
} from '../public-ingress-contract.js';

export const TAILSCALE_FUNNEL_PROVIDER_ID = 'tailscale-funnel';
/** Funnel publishes on 443 (8443 / 10000 are the other allowed ports). */
export const TAILSCALE_FUNNEL_HTTPS_PORT = 443;
const COMMAND_TIMEOUT_MS = 30_000;
const NETWORK_CLASS = 'public_internet' as const;

export interface TailscaleCommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
}

export type TailscaleCommandRunner = (args: string[]) => Promise<TailscaleCommandResult>;

export interface TailscaleFunnelProviderDeps {
  run?: TailscaleCommandRunner;
  now?: () => Date;
}

function defaultRunner(args: string[]): Promise<TailscaleCommandResult> {
  return safeExecResultAsync(resolveTailscaleBin(), args, {
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputMB: 4,
  });
}

/* ------------------------------------------------------------------ *
 * Pure command construction                                           *
 * ------------------------------------------------------------------ */

/** `tailscale funnel --bg --https=443 --set-path=<prefix> http://127.0.0.1:<port><prefix>` */
export function buildTailscaleFunnelUpArgs(localPort: number, pathPrefix: string): string[] {
  const prefix = normalizeIngressPathPrefix(pathPrefix);
  // Tailscale strips the mount point before proxying, so the target carries
  // the prefix again: /events/github → http://127.0.0.1:<port>/events/github.
  return [
    'funnel',
    '--bg',
    `--https=${TAILSCALE_FUNNEL_HTTPS_PORT}`,
    `--set-path=${prefix}`,
    ingressLoopbackTarget(localPort, prefix),
  ];
}

/** `tailscale funnel --https=443 --set-path=<prefix> off` — removes only that mapping. */
export function buildTailscaleFunnelDownArgs(pathPrefix: string): string[] {
  return [
    'funnel',
    `--https=${TAILSCALE_FUNNEL_HTTPS_PORT}`,
    `--set-path=${normalizeIngressPathPrefix(pathPrefix)}`,
    'off',
  ];
}

export const TAILSCALE_STATUS_ARGS = ['status', '--json'] as const;
export const TAILSCALE_FUNNEL_STATUS_ARGS = ['funnel', 'status', '--json'] as const;
export const TAILSCALE_VERSION_ARGS = ['version'] as const;

/* ------------------------------------------------------------------ *
 * Pure parsing                                                        *
 * ------------------------------------------------------------------ */

export interface TailscaleNodeStatus {
  backendState: string;
  /** MagicDNS name without the trailing dot, e.g. mac.tail1234.ts.net */
  dnsName: string;
  httpsCertificates: boolean;
  /** true / false when the node reports capabilities; undefined when it does not. */
  funnelCapability: boolean | undefined;
}

const FUNNEL_CAPS = new Set(['funnel', 'https://tailscale.com/cap/funnel']);
const HTTPS_CAPS = new Set(['https', 'https://tailscale.com/cap/https']);

function capabilityNames(self: Record<string, unknown>): string[] | undefined {
  const names: string[] = [];
  let reported = false;
  if (isRecord(self.CapMap)) {
    reported = true;
    names.push(...Object.keys(self.CapMap));
  }
  if (Array.isArray(self.Capabilities)) {
    reported = true;
    names.push(...self.Capabilities.filter((entry): entry is string => typeof entry === 'string'));
  }
  return reported ? names : undefined;
}

export function parseTailscaleStatus(stdout: string): TailscaleNodeStatus {
  const value = parseSafeJsonInput(stdout, 'tailscale status --json');
  if (!isRecord(value)) throw new Error('tailscale status --json did not return an object');
  const self = isRecord(value.Self) ? value.Self : {};
  const dnsName = typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/u, '') : '';
  const certDomains = Array.isArray(value.CertDomains)
    ? value.CertDomains.filter((entry): entry is string => typeof entry === 'string' && !!entry)
    : [];
  const caps = capabilityNames(self);
  return {
    backendState: typeof value.BackendState === 'string' ? value.BackendState : 'Unknown',
    dnsName,
    httpsCertificates: certDomains.length > 0 || Boolean(caps?.some((cap) => HTTPS_CAPS.has(cap))),
    funnelCapability: caps ? caps.some((cap) => FUNNEL_CAPS.has(cap)) : undefined,
  };
}

export interface TailscaleFunnelMapping {
  /** Proxy target of the handler at the prefix, when one exists. */
  proxy?: string;
  /** Loopback port parsed from the proxy target. */
  localPort?: number;
  /** Funnel (public) is switched on for host:443. */
  funnelEnabled: boolean;
  /** Other handler mount points on host:443 (tailnet-only unless funnelEnabled). */
  otherPaths: string[];
}

function loopbackPort(proxy: string): number | undefined {
  try {
    const url = new URL(proxy);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return undefined;
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return Number.isInteger(port) ? port : undefined;
  } catch {
    return undefined;
  }
}

/** Read the serve/funnel config (`tailscale funnel status --json`) for one host + prefix. */
export function parseTailscaleFunnelMapping(
  stdout: string,
  dnsName: string,
  pathPrefix: string
): TailscaleFunnelMapping {
  const prefix = normalizeIngressPathPrefix(pathPrefix);
  const trimmed = stdout.trim();
  const value = trimmed ? parseSafeJsonInput(trimmed, 'tailscale funnel status --json') : {};
  const config = isRecord(value) ? value : {};
  const hostPort = `${dnsName}:${TAILSCALE_FUNNEL_HTTPS_PORT}`;
  const web = isRecord(config.Web) ? config.Web : {};
  const site = isRecord(web[hostPort]) ? web[hostPort] : {};
  const handlers = isRecord(site.Handlers) ? site.Handlers : {};
  const handler = isRecord(handlers[prefix]) ? handlers[prefix] : undefined;
  const proxy = handler && typeof handler.Proxy === 'string' ? handler.Proxy : undefined;
  const allowFunnel = isRecord(config.AllowFunnel) ? config.AllowFunnel : {};
  return {
    ...(proxy ? { proxy } : {}),
    ...(proxy && loopbackPort(proxy) !== undefined ? { localPort: loopbackPort(proxy) } : {}),
    funnelEnabled: allowFunnel[hostPort] === true,
    otherPaths: Object.keys(handlers)
      .filter((mount) => mount !== prefix)
      .sort(),
  };
}

/* ------------------------------------------------------------------ *
 * Provider                                                            *
 * ------------------------------------------------------------------ */

function commandDetail(result: TailscaleCommandResult): string {
  const text = (result.error?.message || result.stderr || result.stdout || '').trim();
  return text.replace(/\s+/gu, ' ').slice(0, 300) || `exit ${String(result.status)}`;
}

function isMissingBinary(result: TailscaleCommandResult): boolean {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || /ENOENT/u.test(result.error?.message || '');
}

const INSTALL_STEPS = [
  'Install Tailscale (macOS: `brew install --cask tailscale-app`, or https://tailscale.com/download).',
  'Make the CLI reachable: Tailscale menu > Settings > Install CLI, or set KYBERION_TAILSCALE_BIN=/Applications/Tailscale.app/Contents/MacOS/Tailscale.',
];
const LOGIN_STEPS = [
  'Log in to your tailnet: open the Tailscale app and sign in, or run `tailscale up`.',
];
const HTTPS_STEPS = [
  'Admin console > DNS: enable MagicDNS and HTTPS Certificates (https://login.tailscale.com/admin/dns).',
];
const FUNNEL_STEPS = [
  'Admin console > Access controls: grant the `funnel` node attribute to this device (nodeAttrs: {"target": [...], "attr": ["funnel"]}).',
  'Re-run `pnpm kyberion ingress probe` to confirm readiness.',
];

export class TailscaleFunnelProvider implements PublicIngressProvider {
  readonly id = TAILSCALE_FUNNEL_PROVIDER_ID;
  private readonly run: TailscaleCommandRunner;
  private readonly now: () => Date;

  constructor(deps: TailscaleFunnelProviderDeps = {}) {
    this.run = deps.run ?? defaultRunner;
    this.now = deps.now ?? (() => new Date());
  }

  private needsSetup(reason: string, steps: string[]): IngressReadiness {
    return { status: 'needs_setup', reason, setup_steps: steps, network_class: NETWORK_CLASS };
  }

  /** Exactly one of `node` / `readiness` (the setup reason) is set. */
  private async nodeStatus(): Promise<{
    node?: TailscaleNodeStatus;
    readiness?: IngressReadiness;
  }> {
    const result = await this.run([...TAILSCALE_STATUS_ARGS]);
    if (isMissingBinary(result)) {
      return {
        readiness: this.needsSetup('tailscale CLI not found', [...INSTALL_STEPS, ...LOGIN_STEPS]),
      };
    }
    let node: TailscaleNodeStatus;
    try {
      node = parseTailscaleStatus(result.stdout);
    } catch {
      return {
        readiness: this.needsSetup(`tailscale status failed: ${commandDetail(result)}`, [
          ...LOGIN_STEPS,
        ]),
      };
    }
    return { node };
  }

  async probe(): Promise<IngressReadiness> {
    const status = await this.nodeStatus();
    if (status.readiness || !status.node) return status.readiness!;
    const node = status.node;
    if (node.backendState !== 'Running') {
      return this.needsSetup(`tailscale is ${node.backendState}, not Running`, LOGIN_STEPS);
    }
    if (!node.dnsName) return this.needsSetup('MagicDNS name is not available', HTTPS_STEPS);
    if (!node.httpsCertificates) {
      return this.needsSetup('HTTPS certificates are not enabled for the tailnet', HTTPS_STEPS);
    }
    if (node.funnelCapability !== true) {
      return this.needsSetup(
        node.funnelCapability === false
          ? 'the funnel node attribute is not granted to this device'
          : 'this tailscale client does not report node capabilities (update Tailscale)',
        FUNNEL_STEPS
      );
    }
    const funnel = await this.run([...TAILSCALE_FUNNEL_STATUS_ARGS]);
    if (funnel.status !== 0) {
      return this.needsSetup(`tailscale funnel status failed: ${commandDetail(funnel)}`, [
        'Update Tailscale to a version with `tailscale funnel --bg` (1.52 or later).',
      ]);
    }
    return {
      status: 'ready',
      reason: `funnel available on https://${node.dnsName}`,
      network_class: NETWORK_CLASS,
    };
  }

  private async readyNode(): Promise<TailscaleNodeStatus> {
    const readiness = await this.probe();
    if (readiness.status !== 'ready') {
      throw new IngressError('INGRESS_PROVIDER_NOT_READY', readiness.reason, this.id);
    }
    const status = await this.nodeStatus();
    if (!status.node) {
      throw new IngressError(
        'INGRESS_PROVIDER_NOT_READY',
        status.readiness?.reason ?? 'tailscale status unavailable',
        this.id
      );
    }
    return status.node;
  }

  private async mapping(dnsName: string, prefix: string): Promise<TailscaleFunnelMapping> {
    const result = await this.run([...TAILSCALE_FUNNEL_STATUS_ARGS]);
    if (result.status !== 0) {
      throw new IngressError(
        'INGRESS_COMMAND_FAILED',
        `tailscale funnel status failed: ${commandDetail(result)}`,
        this.id
      );
    }
    return parseTailscaleFunnelMapping(result.stdout, dnsName, prefix);
  }

  private exposure(
    surfaceId: string,
    dnsName: string,
    prefix: string,
    localPort: number,
    startedAt?: string
  ): IngressExposure {
    return {
      surface_id: surfaceId,
      provider_id: this.id,
      public_url: joinIngressPublicUrl(`https://${dnsName}`, prefix),
      local_port: localPort,
      path_prefix: prefix,
      started_at: startedAt ?? this.now().toISOString(),
      stable_url: true,
    };
  }

  async up(request: IngressUpRequest): Promise<IngressExposure> {
    const prefix = normalizeIngressPathPrefix(request.pathPrefix);
    const port = assertIngressLocalPort(request.localPort);
    const target = ingressLoopbackTarget(port, prefix);
    const node = await this.readyNode();
    const before = await this.mapping(node.dnsName, prefix);
    if (before.proxy && before.proxy !== target) {
      throw new IngressError(
        'INGRESS_COMMAND_FAILED',
        `path ${prefix} on ${node.dnsName} already proxies to ${before.proxy}; withdraw that mapping first`,
        this.id
      );
    }
    if (!before.funnelEnabled && before.otherPaths.length > 0) {
      throw new IngressError(
        'INGRESS_COMMAND_FAILED',
        `enabling funnel on ${node.dnsName}:${TAILSCALE_FUNNEL_HTTPS_PORT} would also publish tailnet-only mappings (${before.otherPaths.join(', ')}); move them to another port first`,
        this.id
      );
    }
    if (before.proxy !== target || !before.funnelEnabled) {
      const result = await this.run(buildTailscaleFunnelUpArgs(port, prefix));
      if (result.status !== 0) {
        throw new IngressError(
          'INGRESS_COMMAND_FAILED',
          `tailscale funnel failed: ${commandDetail(result)}`,
          this.id
        );
      }
    }
    const after = await this.mapping(node.dnsName, prefix);
    if (after.proxy !== target || !after.funnelEnabled) {
      throw new IngressError(
        'INGRESS_COMMAND_FAILED',
        `tailscale accepted the command but ${prefix} is not published (proxy=${after.proxy ?? 'none'}, funnel=${String(after.funnelEnabled)})`,
        this.id
      );
    }
    return this.exposure(request.surfaceId, node.dnsName, prefix, port);
  }

  async down(request: IngressTargetRequest): Promise<void> {
    const prefix = normalizeIngressPathPrefix(request.pathPrefix ?? request.exposure?.path_prefix);
    const status = await this.nodeStatus();
    if (status.node?.dnsName) {
      const current = await this.mapping(status.node.dnsName, prefix);
      if (!current.proxy) return;
      if (
        request.exposure &&
        current.localPort !== undefined &&
        current.localPort !== request.exposure.local_port
      ) {
        throw new IngressError(
          'INGRESS_COMMAND_FAILED',
          `path ${prefix} now proxies to ${current.proxy}, not this surface; leaving it in place`,
          this.id
        );
      }
    }
    const result = await this.run(buildTailscaleFunnelDownArgs(prefix));
    if (result.status !== 0) {
      throw new IngressError(
        'INGRESS_COMMAND_FAILED',
        `tailscale funnel off failed: ${commandDetail(result)}`,
        this.id
      );
    }
  }

  async status(request: IngressTargetRequest): Promise<IngressExposure | undefined> {
    const prefix = normalizeIngressPathPrefix(request.pathPrefix ?? request.exposure?.path_prefix);
    const status = await this.nodeStatus();
    if (!status.node?.dnsName) return undefined;
    const current = await this.mapping(status.node.dnsName, prefix);
    if (!current.proxy || !current.funnelEnabled || current.localPort === undefined) {
      return undefined;
    }
    return this.exposure(
      request.surfaceId,
      status.node.dnsName,
      prefix,
      current.localPort,
      request.exposure?.started_at ?? ''
    );
  }
}

/** Module entry point resolved by public-ingress-provider-registry. */
export function createPublicIngressProvider(
  deps: TailscaleFunnelProviderDeps = {}
): PublicIngressProvider {
  return new TailscaleFunnelProvider(deps);
}
