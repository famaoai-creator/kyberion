import { logger } from '@agent/core/core';
import {
  assertSafeRepositoryPath,
  safeExec,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { resolvePipelineContextValues } from '@agent/core/src/logic-utils';
import { assertValidMobileAppProfile } from '@agent/core/mobile-profile-validators';
import type { MobileAppProfile } from '@agent/core/app-profiles';
import { retry } from '@agent/core/async-utils';
import { isRecord, nowIso, parseSafeJsonInput } from '@agent/core/foundation';
import { createGovernedRetryOptionsBuilder } from '@agent/core/recovery-policy';
import { runAdfActuatorPipeline } from '../../../core/actuator-sdk.js';
import type { AdfEngineContext } from '../../../core/adf-engine.js';
import {
  DEFAULT_MAX_PIPELINE_STEPS,
  DEFAULT_PIPELINE_TIMEOUT_MS,
} from '@agent/core/execution-bounds';
import { ensureDefaultOpPreflight } from '@agent/core/op-preflight-defaults';
import * as path from 'node:path';

const IOS_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/ios-actuator/manifest.json');
export const DEFAULT_IOS_RETRY = {
  maxRetries: 2,
  initialDelayMs: 250,
  maxDelayMs: 2000,
  factor: 2,
  jitter: true,
};

export const buildRetryOptions = createGovernedRetryOptionsBuilder({
  manifestPath: IOS_MANIFEST_PATH,
  defaults: DEFAULT_IOS_RETRY,
  fallbackCategories: ['resource_unavailable', 'timeout'],
});

function resolveIosRepositoryPath(rootDir: string, value: unknown): string {
  return assertSafeRepositoryPath(path.resolve(rootDir, String(value || '').trim()), {
    allowMissingLeaf: true,
  });
}

export interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: Record<string, unknown>;
}

export interface IOSAction {
  action: 'pipeline';
  steps: PipelineStep[];
  options?: {
    device_udid?: string;
    timeout_ms?: number;
    artifacts_dir?: string;
  };
  context?: Record<string, unknown>;
}

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
  runtime: string;
}

export async function executePipeline(
  steps: PipelineStep[],
  options: IOSAction['options'] = {},
  initialCtx: AdfEngineContext = {}
) {
  ensureDefaultOpPreflight();
  const rootDir = pathResolver.rootDir();
  const artifactsDir = resolveIosRepositoryPath(
    rootDir,
    options?.artifacts_dir || pathResolver.sharedTmp(`actuators/ios-actuator/session_${Date.now()}`)
  );
  if (!safeExistsSync(artifactsDir)) safeMkdir(artifactsDir, { recursive: true });

  let ctx: AdfEngineContext = {
    ...initialCtx,
    timestamp: nowIso(),
    artifacts_dir: artifactsDir,
    ios_device_udid:
      options?.device_udid ||
      (typeof initialCtx.ios_device_udid === 'string' ? initialCtx.ios_device_udid : ''),
  };

  const executableSteps = steps
    .filter((step): step is PipelineStep => {
      if (
        step.type === 'capture' ||
        step.type === 'transform' ||
        step.type === 'apply' ||
        step.type === 'control'
      ) {
        return true;
      }
      logger.warn(`[IOS_PIPELINE] Unsupported step type: ${String(step.type)}`);
      return false;
    })
    .map((step) => ({ ...step, op: `ios:${step.op}` }));

  const sequence = await runAdfActuatorPipeline({
    actuatorId: 'ios',
    steps: executableSteps,
    context: ctx,
    options: {
      maxSteps: DEFAULT_MAX_PIPELINE_STEPS,
      timeoutMs: options?.timeout_ms ?? DEFAULT_PIPELINE_TIMEOUT_MS,
      resolveVars: (value, context) => resolvePipelineContextValues(value, context),
    },
    handlers: {
      capture: (op, params, context, resolve) =>
        opCapture(stripIosOpPrefix(op), params, context, resolve, options),
      transform: (op, params, context, resolve) =>
        opTransform(stripIosOpPrefix(op), params, context, resolve),
      apply: (op, params, context, resolve) =>
        opApply(stripIosOpPrefix(op), params, context, resolve, options),
    },
    hooks: {
      beforeStep: (step) =>
        logger.info(`  [IOS_PIPELINE] ${step.type}:${stripIosOpPrefix(step.op)}...`),
      afterStep: (step, _stepNumber, _context, outcome) => {
        if (outcome.status === 'failed') {
          logger.error(
            `  [IOS_PIPELINE] Step failed (${stripIosOpPrefix(step.op)}): ${outcome.error || 'unknown error'}`
          );
        }
      },
    },
  });
  ctx = sequence.context;

  if (initialCtx.context_path) {
    await retry(async () => {
      safeWriteFile(
        resolveIosRepositoryPath(rootDir, initialCtx.context_path),
        JSON.stringify(ctx, null, 2)
      );
      return undefined;
    }, buildRetryOptions());
  }

  return {
    status: sequence.status,
    results: sequence.results.map((result) => ({
      ...result,
      op: stripIosOpPrefix(result.op),
    })),
    context: ctx,
  };
}

function stripIosOpPrefix(op: string): string {
  return op.startsWith('ios:') ? op.slice('ios:'.length) : op;
}

async function opCapture(
  op: string,
  params: any,
  ctx: Record<string, any>,
  resolve: (val: any) => any,
  options?: IOSAction['options']
) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'read_json': {
      const sourcePath = resolveIosRepositoryPath(rootDir, resolve(params.path));
      const parsed = await retry(async () => {
        const content = safeReadFile(sourcePath, { encoding: 'utf8' }) as string;
        return parseSafeJsonInput(content, 'iOS JSON input');
      }, buildRetryOptions());
      if (params.validate_as === 'mobile-app-profile') {
        assertValidMobileAppProfile(parsed, sourcePath);
      }
      return { ...ctx, [params.export_as || 'last_json']: parsed };
    }
    case 'read_text_file': {
      const sourcePath = resolveIosRepositoryPath(rootDir, resolve(params.path));
      const content = await retry(
        async () => safeReadFile(sourcePath, { encoding: 'utf8' }) as string,
        buildRetryOptions()
      );
      return { ...ctx, [params.export_as || 'last_text']: content };
    }
    case 'simctl_health_check': {
      const health = await retry(
        async () => collectSimctlHealth(ctx, options),
        buildRetryOptions()
      );
      return {
        ...ctx,
        [params.export_as || 'simctl_health']: health,
        ios_available: health.available,
        ios_device_udid: health.selected_udid || ctx.ios_device_udid,
      };
    }
    case 'capture_runtime_session_handoff': {
      ensureSimctlAvailable(ctx, options);
      const device = resolveDeviceUdid(ctx, options, params);
      const bundleId = resolveBundleId(params, ctx, resolve);
      if (!bundleId) {
        throw new Error(
          'capture_runtime_session_handoff requires params.bundle_id or an app_profile with launch.bundle_id/package_name'
        );
      }
      const profile = resolveAppProfile(params, ctx);
      const relativePath = String(
        resolve(
          params.container_relative_path ||
            profile?.webview?.runtime_export?.ios_container_relative_path ||
            ''
        )
      ).trim();
      if (!relativePath) {
        throw new Error(
          'capture_runtime_session_handoff requires params.container_relative_path or app_profile.webview.runtime_export.ios_container_relative_path'
        );
      }
      const containerRoot = await retry(
        async () => runSimctl(['get_app_container', device, bundleId, 'data'], options).trim(),
        buildRetryOptions()
      );
      const sourcePath = path.join(containerRoot, relativePath);
      const outPath = resolveIosRepositoryPath(
        rootDir,
        resolve(
          params.path ||
            path.join(ctx.artifacts_dir, `ios-runtime-session-handoff-${Date.now()}.json`)
        )
      );
      ensureParentDir(outPath);
      const content = await retry(
        async () => safeReadFile(sourcePath, { encoding: 'utf8' }) as string,
        buildRetryOptions()
      );
      await retry(async () => {
        safeWriteFile(outPath, content);
        return undefined;
      }, buildRetryOptions());
      return {
        ...ctx,
        [params.export_as || 'runtime_session_handoff']: await retry(
          async () => parseSafeJsonInput(content, 'iOS session handoff'),
          buildRetryOptions()
        ),
        runtime_session_handoff_path: outPath,
      };
    }
    default:
      throw new Error(`[UNKNOWN_OP] Unknown op: ${op}`);
  }
}

async function opTransform(
  op: string,
  params: any,
  ctx: Record<string, any>,
  resolve: (val: any) => any
) {
  switch (op) {
    case 'set': {
      const key = resolve(params.key);
      if (!key) return ctx;
      return { ...ctx, [key]: resolve(params.value) };
    }
    default:
      throw new Error(`[UNKNOWN_OP] Unknown op: ${op}`);
  }
}

async function opApply(
  op: string,
  params: any,
  ctx: Record<string, any>,
  resolve: (val: any) => any,
  options?: IOSAction['options']
) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'launch_app': {
      ensureSimctlAvailable(ctx, options);
      const device = resolveDeviceUdid(ctx, options, params);
      const bundleId = resolveBundleId(params, ctx, resolve);
      if (!bundleId)
        throw new Error(
          'launch_app requires params.bundle_id or an app_profile with launch.bundle_id/package_name'
        );
      const output = await retry(
        async () => runSimctl(['launch', device, bundleId], options),
        buildRetryOptions()
      );
      return {
        ...ctx,
        last_launch_output: output,
        ios_device_udid: device,
        ios_bundle_id: bundleId,
      };
    }
    case 'install_app': {
      ensureSimctlAvailable(ctx, options);
      const device = resolveDeviceUdid(ctx, options, params, { allowShutdownMatch: true });
      const appPath = resolveAppPath(params, ctx, resolve, rootDir);
      if (!appPath)
        throw new Error(
          'install_app requires params.app_path or an app_profile with launch.app_path'
        );
      if (!safeExistsSync(appPath))
        throw new Error(`install_app app_path does not exist: ${appPath}`);
      const output = await retry(
        async () => runSimctl(['install', device, appPath], options),
        buildRetryOptions()
      );
      return {
        ...ctx,
        last_install_output: output,
        last_installed_app_path: appPath,
        ios_device_udid: device,
      };
    }
    case 'boot_simulator': {
      ensureSimctlAvailable(ctx, options);
      const device = resolveDeviceUdid(ctx, options, params, { allowShutdownMatch: true });
      try {
        const output = await retry(
          async () => runSimctl(['boot', device], options),
          buildRetryOptions()
        );
        return { ...ctx, last_boot_output: output, ios_device_udid: device };
      } catch (error: any) {
        const message = String(error?.message || '');
        if (message.includes('Unable to boot device in current state: Booted')) {
          return { ...ctx, last_boot_output: 'already_booted', ios_device_udid: device };
        }
        throw error;
      }
    }
    case 'shutdown_simulator': {
      ensureSimctlAvailable(ctx, options);
      const device = resolveDeviceUdid(ctx, options, params, { allowShutdownMatch: true });
      const output = await retry(
        async () => runSimctl(['shutdown', device], options),
        buildRetryOptions()
      );
      return { ...ctx, last_shutdown_output: output, ios_device_udid: device };
    }
    case 'uninstall_app': {
      ensureSimctlAvailable(ctx, options);
      const device = resolveDeviceUdid(ctx, options, params, { allowShutdownMatch: true });
      const bundleId = resolveBundleId(params, ctx, resolve);
      if (!bundleId)
        throw new Error(
          'uninstall_app requires params.bundle_id or an app_profile with launch.bundle_id/package_name'
        );
      const output = await retry(
        async () => runSimctl(['uninstall', device, bundleId], options),
        buildRetryOptions()
      );
      return {
        ...ctx,
        last_uninstall_output: output,
        ios_device_udid: device,
        ios_bundle_id: bundleId,
      };
    }
    case 'open_deep_link': {
      ensureSimctlAvailable(ctx, options);
      const device = resolveDeviceUdid(ctx, options, params);
      const url = String(resolve(params.url || '')).trim();
      if (!url) throw new Error('open_deep_link requires params.url');
      const output = await retry(
        async () => runSimctl(['openurl', device, url], options),
        buildRetryOptions()
      );
      return { ...ctx, last_deep_link_output: output, ios_device_udid: device };
    }
    case 'capture_screen': {
      ensureSimctlAvailable(ctx, options);
      const device = resolveDeviceUdid(ctx, options, params);
      const outPath = resolveIosRepositoryPath(
        rootDir,
        resolve(params.path || path.join(ctx.artifacts_dir, `ios-screen-${Date.now()}.png`))
      );
      ensureParentDir(outPath);
      await retry(
        async () => runSimctl(['io', device, 'screenshot', outPath], options),
        buildRetryOptions()
      );
      return { ...ctx, last_screenshot_path: outPath, ios_device_udid: device };
    }
    case 'emit_session_handoff': {
      const handoff = buildSessionHandoffArtifact(params, ctx, resolve);
      const outPath = resolveIosRepositoryPath(
        rootDir,
        resolve(
          params.path || path.join(ctx.artifacts_dir, `ios-session-handoff-${Date.now()}.json`)
        )
      );
      ensureParentDir(outPath);
      await retry(async () => {
        safeWriteFile(outPath, JSON.stringify(handoff, null, 2));
        return undefined;
      }, buildRetryOptions());
      return {
        ...ctx,
        [params.export_as || 'session_handoff']: handoff,
        session_handoff_path: outPath,
      };
    }
    case 'log': {
      logger.info(`[IOS_LOG] ${resolve(params.message)}`);
      return ctx;
    }
    default:
      throw new Error(`[UNKNOWN_OP] Unknown op: ${op}`);
  }
}

function collectSimctlHealth(ctx: Record<string, any>, options?: IOSAction['options']) {
  try {
    const timeoutMs = options?.timeout_ms || 60000;
    const xcrunVersion = safeExec('xcrun', ['--version'], { timeoutMs }).trim();
    const devicesOutput = safeExec('xcrun', ['simctl', 'list', 'devices', '--json'], {
      timeoutMs,
    }).trim();
    const devices = parseSimctlDevices(devicesOutput);
    const preferred = options?.device_udid || ctx.ios_device_udid || '';
    const booted = devices.find(
      (device) => device.state === 'Booted' && device.isAvailable !== false
    );
    const selected = preferred || booted?.udid || '';
    return {
      available: true,
      xcrun_version: xcrunVersion,
      devices,
      selected_udid: selected,
    };
  } catch (error: any) {
    return {
      available: false,
      error: error.message,
      devices: [],
      selected_udid: '',
    };
  }
}

export function parseSimctlDevices(output: string): SimctlDevice[] {
  const parsed: unknown = parseSafeJsonInput(output, 'simctl devices response');
  if (!isRecord(parsed) || !isRecord(parsed.devices)) return [];

  return Object.entries(parsed.devices).flatMap(([runtime, devices]) => {
    if (!Array.isArray(devices)) return [];
    return devices.flatMap((candidate): SimctlDevice[] => {
      if (!isRecord(candidate)) return [];
      if (
        typeof candidate.udid !== 'string' ||
        !candidate.udid.trim() ||
        typeof candidate.name !== 'string' ||
        !candidate.name.trim() ||
        typeof candidate.state !== 'string' ||
        !candidate.state.trim() ||
        (candidate.isAvailable !== undefined && typeof candidate.isAvailable !== 'boolean')
      ) {
        return [];
      }
      return [
        {
          udid: candidate.udid,
          name: candidate.name,
          state: candidate.state,
          isAvailable: typeof candidate.isAvailable === 'boolean' ? candidate.isAvailable : true,
          runtime,
        },
      ];
    });
  });
}

function ensureSimctlAvailable(ctx: Record<string, any>, options?: IOSAction['options']) {
  const health = collectSimctlHealth(ctx, options);
  if (!health.available) {
    throw new Error(`simctl is not available: ${health.error}`);
  }
}

function runSimctl(args: string[], options?: IOSAction['options']): string {
  return safeExec('xcrun', ['simctl', ...args], { timeoutMs: options?.timeout_ms || 30000 }).trim();
}

function resolveDeviceUdid(
  ctx: Record<string, any>,
  options: IOSAction['options'] | undefined,
  params: any,
  behavior: { allowShutdownMatch?: boolean } = {}
): string {
  const explicit = String(
    params?.device_udid || options?.device_udid || ctx.ios_device_udid || ''
  ).trim();
  if (explicit) return explicit;
  const health = collectSimctlHealth(ctx, options);
  if (!health.available) {
    throw new Error(`simctl is not available: ${health.error}`);
  }
  if (health.selected_udid) return health.selected_udid;

  const preferredName = String(params?.device_name || '')
    .trim()
    .toLowerCase();
  const availableDevices = health.devices.filter((device) => device.isAvailable !== false);
  const nameMatched = preferredName
    ? availableDevices.find((device) => device.name.toLowerCase() === preferredName) ||
      availableDevices.find((device) => device.name.toLowerCase().includes(preferredName))
    : undefined;
  if (nameMatched) return nameMatched.udid;

  if (behavior.allowShutdownMatch && availableDevices.length > 0) {
    return availableDevices[0].udid;
  }

  throw new Error(
    'No booted iOS simulator found. Provide params.device_udid, params.device_name, or boot a simulator first.'
  );
}

function resolveBundleId(
  params: any,
  ctx: Record<string, any>,
  resolve: (val: any) => any
): string {
  const explicit = String(resolve(params.bundle_id || '')).trim();
  if (explicit) return explicit;
  const profile = resolveAppProfile(params, ctx);
  if (!profile) return '';
  return String(profile.launch?.bundle_id || profile.package_name || '').trim();
}

function resolveAppPath(
  params: any,
  ctx: Record<string, any>,
  resolve: (val: any) => any,
  rootDir: string
): string {
  const explicit = String(resolve(params.app_path || '')).trim();
  if (explicit) return resolveIosRepositoryPath(rootDir, explicit);
  const profile = resolveAppProfile(params, ctx);
  const profilePath = String(profile?.launch?.app_path || '').trim();
  return profilePath ? resolveIosRepositoryPath(rootDir, profilePath) : '';
}

function buildSessionHandoffArtifact(
  params: any,
  ctx: Record<string, any>,
  resolve: (val: any) => any
) {
  const profile = resolveAppProfile(params, ctx);
  const targetUrl = String(
    resolve(
      params.target_url ||
        profile?.webview?.session_handoff?.target_url ||
        profile?.webview?.entry_url ||
        ''
    )
  ).trim();
  if (!targetUrl)
    throw new Error(
      'emit_session_handoff requires params.target_url or app_profile.webview.session_handoff.target_url'
    );

  return {
    kind: 'webview-session-handoff',
    target_url: targetUrl,
    origin: safeOrigin(targetUrl),
    browser_session_id: String(
      resolve(
        params.browser_session_id ||
          profile?.webview?.session_handoff?.browser_session_id ||
          'ios-webview'
      )
    ),
    prefer_persistent_context:
      params.prefer_persistent_context ??
      profile?.webview?.session_handoff?.prefer_persistent_context ??
      true,
    cookies: resolveObjectRef(params.cookies_from, ctx) || resolve(params.cookies) || [],
    local_storage:
      resolveObjectRef(params.local_storage_from, ctx) || resolve(params.local_storage) || {},
    session_storage:
      resolveObjectRef(params.session_storage_from, ctx) || resolve(params.session_storage) || {},
    headers: resolveObjectRef(params.headers_from, ctx) || resolve(params.headers) || {},
    source: {
      platform: 'ios',
      app_id: profile?.app_id || ctx.app_id || 'ios-app',
    },
  };
}

function resolveObjectRef(key: any, ctx: Record<string, any>): any {
  if (!key || typeof key !== 'string') return undefined;
  return ctx[key];
}

function safeOrigin(targetUrl: string): string {
  try {
    return new URL(targetUrl).origin;
  } catch {
    return '';
  }
}

function resolveAppProfile(params: any, ctx: Record<string, any>): MobileAppProfile | undefined {
  if (params.app_profile && typeof params.app_profile === 'object') {
    assertValidMobileAppProfile(params.app_profile, 'params.app_profile');
    return params.app_profile as MobileAppProfile;
  }
  if (params.profile && typeof params.profile === 'object') {
    assertValidMobileAppProfile(params.profile, 'params.profile');
    return params.profile as MobileAppProfile;
  }
  if (typeof params.app_profile_from === 'string' && ctx[params.app_profile_from]) {
    assertValidMobileAppProfile(ctx[params.app_profile_from], `ctx.${params.app_profile_from}`);
    return ctx[params.app_profile_from] as MobileAppProfile;
  }
  if (typeof params.profile_from === 'string' && ctx[params.profile_from]) {
    assertValidMobileAppProfile(ctx[params.profile_from], `ctx.${params.profile_from}`);
    return ctx[params.profile_from] as MobileAppProfile;
  }
  if (ctx.app_profile) {
    assertValidMobileAppProfile(ctx.app_profile, 'ctx.app_profile');
    return ctx.app_profile as MobileAppProfile;
  }
  return undefined;
}

function ensureParentDir(targetPath: string): void {
  const dir = path.dirname(targetPath);
  if (!safeExistsSync(dir)) {
    safeMkdir(dir, { recursive: true });
  }
}
