import {
  logger,
  safeExec,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  derivePipelineStatus,
  pathResolver,
  resolveVars,
  assertValidMobileAppProfile,
  withRetry,
  classifyError,
} from '@agent/core';
import type { MobileAppProfile } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const IOS_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/ios-actuator/manifest.json');
const DEFAULT_IOS_RETRY = {
  maxRetries: 2,
  initialDelayMs: 250,
  maxDelayMs: 2000,
  factor: 2,
  jitter: true,
};

let cachedRecoveryPolicy: Record<string, any> | null = null;

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadRecoveryPolicy(): Record<string, any> {
  if (cachedRecoveryPolicy) return cachedRecoveryPolicy;
  try {
    const manifest = JSON.parse(safeReadFile(IOS_MANIFEST_PATH, { encoding: 'utf8' }) as string);
    cachedRecoveryPolicy = isPlainObject(manifest?.recovery_policy) ? manifest.recovery_policy : {};
  } catch {
    cachedRecoveryPolicy = {};
  }
  return cachedRecoveryPolicy;
}

function buildRetryOptions() {
  const policy = loadRecoveryPolicy();
  const retry = isPlainObject(policy.retry) ? policy.retry : DEFAULT_IOS_RETRY;
  const retryableCategories = new Set<string>(
    Array.isArray(policy.retryable_categories) ? policy.retryable_categories.map(String) : [],
  );
  return {
    ...DEFAULT_IOS_RETRY,
    ...retry,
    shouldRetry: (error: Error) => {
      const classification = classifyError(error);
      return retryableCategories.size > 0
        ? retryableCategories.has(classification.category)
        : classification.category === 'resource_unavailable' ||
            classification.category === 'timeout' ||
            classification.category === 'network';
    },
  };
}

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

interface IOSAction {
  action: 'pipeline';
  steps: PipelineStep[];
  options?: {
    device_udid?: string;
    timeout_ms?: number;
    artifacts_dir?: string;
  };
  context?: Record<string, any>;
}

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
  runtime: string;
}

async function handleAction(input: IOSAction) {
  if (input.action !== 'pipeline') {
    throw new Error(`Unsupported action: ${input.action}`);
  }
  return executePipeline(input.steps || [], input.options || {}, input.context || {});
}

async function executePipeline(steps: PipelineStep[], options: IOSAction['options'] = {}, initialCtx: Record<string, any> = {}) {
  const rootDir = pathResolver.rootDir();
  const artifactsDir = path.resolve(
    rootDir,
    options?.artifacts_dir || pathResolver.sharedTmp(`actuators/ios-actuator/session_${Date.now()}`),
  );
  if (!safeExistsSync(artifactsDir)) safeMkdir(artifactsDir, { recursive: true });

  let ctx: Record<string, any> = {
    ...initialCtx,
    timestamp: new Date().toISOString(),
    artifacts_dir: artifactsDir,
    ios_device_udid: options?.device_udid || initialCtx.ios_device_udid || '',
  };

  const resolve = (val: any): any => resolveVars(val, ctx);

  const results: Array<{ op: string; status: 'success' | 'failed'; error?: string }> = [];

  for (const step of steps) {
    try {
      logger.info(`  [IOS_PIPELINE] ${step.type}:${step.op}...`);
      switch (step.type) {
        case 'capture':
          ctx = await opCapture(step.op, step.params, ctx, resolve, options);
          break;
        case 'transform':
          ctx = await opTransform(step.op, step.params, ctx, resolve);
          break;
        case 'apply':
          ctx = await opApply(step.op, step.params, ctx, resolve, options);
          break;
        default:
          logger.warn(`[IOS_PIPELINE] Unsupported step type: ${step.type}`);
      }
      results.push({ op: step.op, status: 'success' });
    } catch (error: any) {
      logger.error(`  [IOS_PIPELINE] Step failed (${step.op}): ${error.message}`);
      results.push({ op: step.op, status: 'failed', error: error.message });
      break;
    }
  }

  if (initialCtx.context_path) {
    await withRetry(
      async () => {
        safeWriteFile(path.resolve(rootDir, initialCtx.context_path), JSON.stringify(ctx, null, 2));
        return undefined;
      },
      buildRetryOptions(),
    );
  }

  return {
    status: derivePipelineStatus(results),
    results,
    context: ctx,
  };
}

async function opCapture(
  op: string,
  params: any,
  ctx: Record<string, any>,
  resolve: (val: any) => any,
  options?: IOSAction['options'],
) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'read_json': {
      const sourcePath = path.resolve(rootDir, resolve(params.path));
      const parsed = await withRetry(async () => {
        const content = safeReadFile(sourcePath, { encoding: 'utf8' }) as string;
        return JSON.parse(content);
      }, buildRetryOptions());
      if (params.validate_as === 'mobile-app-profile') {
        assertValidMobileAppProfile(parsed, sourcePath);
      }
      return { ...ctx, [params.export_as || 'last_json']: parsed };
    }
    case 'read_text_file': {
      const sourcePath = path.resolve(rootDir, resolve(params.path));
      const content = await withRetry(
        async () => safeReadFile(sourcePath, { encoding: 'utf8' }) as string,
        buildRetryOptions(),
      );
      return { ...ctx, [params.export_as || 'last_text']: content };
    }
    case 'simctl_health_check': {
      const health = await withRetry(async () => collectSimctlHealth(ctx, options), buildRetryOptions());
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
        throw new Error('capture_runtime_session_handoff requires params.bundle_id or an app_profile with launch.bundle_id/package_name');
      }
      const profile = resolveAppProfile(params, ctx);
      const relativePath = String(
        resolve(params.container_relative_path || profile?.webview?.runtime_export?.ios_container_relative_path || ''),
      ).trim();
      if (!relativePath) {
        throw new Error(
          'capture_runtime_session_handoff requires params.container_relative_path or app_profile.webview.runtime_export.ios_container_relative_path',
        );
      }
      const containerRoot = await withRetry(
        async () => runSimctl(['get_app_container', device, bundleId, 'data'], options).trim(),
        buildRetryOptions(),
      );
      const sourcePath = path.join(containerRoot, relativePath);
      const outPath = path.resolve(
        rootDir,
        resolve(params.path || path.join(ctx.artifacts_dir, `ios-runtime-session-handoff-${Date.now()}.json`)),
      );
      ensureParentDir(outPath);
      const content = await withRetry(
        async () => safeReadFile(sourcePath, { encoding: 'utf8' }) as string,
        buildRetryOptions(),
      );
      await withRetry(
        async () => {
          safeWriteFile(outPath, content);
          return undefined;
        },
        buildRetryOptions(),
      );
      return {
        ...ctx,
        [params.export_as || 'runtime_session_handoff']: await withRetry(
          async () => JSON.parse(content),
          buildRetryOptions(),
        ),
        runtime_session_handoff_path: outPath,
      };
    }
    default:
      logger.warn(`[IOS_CAPTURE] Unknown capture op: ${op}`);
      return ctx;
  }
}

async function opTransform(
  op: string,
  params: any,
  ctx: Record<string, any>,
  resolve: (val: any) => any,
) {
  switch (op) {
    case 'set': {
      const key = resolve(params.key);
      if (!key) return ctx;
      return { ...ctx, [key]: resolve(params.value) };
    }
    default:
      logger.warn(`[IOS_TRANSFORM] Unknown transform op: ${op}`);
      return ctx;
  }
}

async function opApply(
  op: string,
  params: any,
  ctx: Record<string, any>,
  resolve: (val: any) => any,
  options?: IOSAction['options'],
) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'launch_app': {
      ensureSimctlAvailable(ctx, options);
      const device = resolveDeviceUdid(ctx, options, params);
      const bundleId = resolveBundleId(params, ctx, resolve);
      if (!bundleId) throw new Error('launch_app requires params.bundle_id or an app_profile with launch.bundle_id/package_name');
      const output = await withRetry(async () => runSimctl(['launch', device, bundleId], options), buildRetryOptions());
      return { ...ctx, last_launch_output: output, ios_device_udid: device, ios_bundle_id: bundleId };
    }
    case 'install_app': {
      ensureSimctlAvailable(ctx, options);
      const device = resolveDeviceUdid(ctx, options, params, { allowShutdownMatch: true });
      const appPath = resolveAppPath(params, ctx, resolve, rootDir);
      if (!appPath) throw new Error('install_app requires params.app_path or an app_profile with launch.app_path');
      if (!safeExistsSync(appPath)) throw new Error(`install_app app_path does not exist: ${appPath}`);
      const output = await withRetry(async () => runSimctl(['install', device, appPath], options), buildRetryOptions());
      return { ...ctx, last_install_output: output, last_installed_app_path: appPath, ios_device_udid: device };
    }
    case 'boot_simulator': {
      ensureSimctlAvailable(ctx, options);
      const device = resolveDeviceUdid(ctx, options, params, { allowShutdownMatch: true });
      try {
        const output = await withRetry(async () => runSimctl(['boot', device], options), buildRetryOptions());
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
      const output = await withRetry(async () => runSimctl(['shutdown', device], options), buildRetryOptions());
      return { ...ctx, last_shutdown_output: output, ios_device_udid: device };
    }
    case 'uninstall_app': {
      ensureSimctlAvailable(ctx, options);
      const device = resolveDeviceUdid(ctx, options, params, { allowShutdownMatch: true });
      const bundleId = resolveBundleId(params, ctx, resolve);
      if (!bundleId) throw new Error('uninstall_app requires params.bundle_id or an app_profile with launch.bundle_id/package_name');
      const output = await withRetry(async () => runSimctl(['uninstall', device, bundleId], options), buildRetryOptions());
      return { ...ctx, last_uninstall_output: output, ios_device_udid: device, ios_bundle_id: bundleId };
    }
    case 'open_deep_link': {
      ensureSimctlAvailable(ctx, options);
      const device = resolveDeviceUdid(ctx, options, params);
      const url = String(resolve(params.url || '')).trim();
      if (!url) throw new Error('open_deep_link requires params.url');
      const output = await withRetry(async () => runSimctl(['openurl', device, url], options), buildRetryOptions());
      return { ...ctx, last_deep_link_output: output, ios_device_udid: device };
    }
    case 'capture_screen': {
      ensureSimctlAvailable(ctx, options);
      const device = resolveDeviceUdid(ctx, options, params);
      const outPath = path.resolve(rootDir, resolve(params.path || path.join(ctx.artifacts_dir, `ios-screen-${Date.now()}.png`)));
      ensureParentDir(outPath);
      await withRetry(async () => runSimctl(['io', device, 'screenshot', outPath], options), buildRetryOptions());
      return { ...ctx, last_screenshot_path: outPath, ios_device_udid: device };
    }
    case 'emit_session_handoff': {
      const handoff = buildSessionHandoffArtifact(params, ctx, resolve);
      const outPath = path.resolve(rootDir, resolve(params.path || path.join(ctx.artifacts_dir, `ios-session-handoff-${Date.now()}.json`)));
      ensureParentDir(outPath);
      await withRetry(
        async () => {
          safeWriteFile(outPath, JSON.stringify(handoff, null, 2));
          return undefined;
        },
        buildRetryOptions(),
      );
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
      logger.warn(`[IOS_APPLY] Unknown apply op: ${op}`);
      return ctx;
  }
}

function collectSimctlHealth(ctx: Record<string, any>, options?: IOSAction['options']) {
  try {
    const timeoutMs = options?.timeout_ms || 60000;
    const xcrunVersion = safeExec('xcrun', ['--version'], { timeoutMs }).trim();
    const devicesOutput = safeExec('xcrun', ['simctl', 'list', 'devices', '--json'], { timeoutMs }).trim();
    const devices = parseSimctlDevices(devicesOutput);
    const preferred = options?.device_udid || ctx.ios_device_udid || '';
    const booted = devices.find((device) => device.state === 'Booted' && device.isAvailable !== false);
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

function parseSimctlDevices(output: string): SimctlDevice[] {
  const parsed = JSON.parse(output) as { devices?: Record<string, Array<Record<string, any>>> };
  const entries = parsed.devices || {};
  return Object.entries(entries).flatMap(([runtime, devices]) =>
    devices.map((device) => ({
      udid: String(device.udid || ''),
      name: String(device.name || ''),
      state: String(device.state || 'unknown'),
      isAvailable: typeof device.isAvailable === 'boolean' ? device.isAvailable : true,
      runtime,
    })),
  );
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
  behavior: { allowShutdownMatch?: boolean } = {},
): string {
  const explicit = String(params?.device_udid || options?.device_udid || ctx.ios_device_udid || '').trim();
  if (explicit) return explicit;
  const health = collectSimctlHealth(ctx, options);
  if (!health.available) {
    throw new Error(`simctl is not available: ${health.error}`);
  }
  if (health.selected_udid) return health.selected_udid;

  const preferredName = String(params?.device_name || '').trim().toLowerCase();
  const availableDevices = health.devices.filter((device) => device.isAvailable !== false);
  const nameMatched = preferredName
    ? availableDevices.find((device) => device.name.toLowerCase() === preferredName) ||
      availableDevices.find((device) => device.name.toLowerCase().includes(preferredName))
    : undefined;
  if (nameMatched) return nameMatched.udid;

  if (behavior.allowShutdownMatch && availableDevices.length > 0) {
    return availableDevices[0].udid;
  }

  throw new Error('No booted iOS simulator found. Provide params.device_udid, params.device_name, or boot a simulator first.');
}

function resolveBundleId(params: any, ctx: Record<string, any>, resolve: (val: any) => any): string {
  const explicit = String(resolve(params.bundle_id || '')).trim();
  if (explicit) return explicit;
  const profile = resolveAppProfile(params, ctx);
  if (!profile) return '';
  return String(profile.launch?.bundle_id || profile.package_name || '').trim();
}

function resolveAppPath(params: any, ctx: Record<string, any>, resolve: (val: any) => any, rootDir: string): string {
  const explicit = String(resolve(params.app_path || '')).trim();
  if (explicit) return path.resolve(rootDir, explicit);
  const profile = resolveAppProfile(params, ctx);
  const profilePath = String(profile?.launch?.app_path || '').trim();
  return profilePath ? path.resolve(rootDir, profilePath) : '';
}

function buildSessionHandoffArtifact(
  params: any,
  ctx: Record<string, any>,
  resolve: (val: any) => any,
) {
  const profile = resolveAppProfile(params, ctx);
  const targetUrl = String(
    resolve(params.target_url || profile?.webview?.session_handoff?.target_url || profile?.webview?.entry_url || ''),
  ).trim();
  if (!targetUrl) throw new Error('emit_session_handoff requires params.target_url or app_profile.webview.session_handoff.target_url');

  return {
    kind: 'webview-session-handoff',
    target_url: targetUrl,
    origin: safeOrigin(targetUrl),
    browser_session_id: String(resolve(params.browser_session_id || profile?.webview?.session_handoff?.browser_session_id || 'ios-webview')),
    prefer_persistent_context:
      params.prefer_persistent_context ?? profile?.webview?.session_handoff?.prefer_persistent_context ?? true,
    cookies: resolveObjectRef(params.cookies_from, ctx) || resolve(params.cookies) || [],
    local_storage: resolveObjectRef(params.local_storage_from, ctx) || resolve(params.local_storage) || {},
    session_storage: resolveObjectRef(params.session_storage_from, ctx) || resolve(params.session_storage) || {},
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

function resolveKey(key: string, ctx: Record<string, any>): any {
  const parts = key.split('.');
  let current: any = ctx;
  for (const part of parts) {
    current = current?.[part];
  }
  return current;
}

const main = async () => {
  const argv = await createStandardYargs().option('input', { alias: 'i', type: 'string', required: true }).parseSync();
  const inputPath = path.resolve(pathResolver.rootDir(), argv.input as string);
  const content = safeReadFile(inputPath, { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(content));
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleAction };
