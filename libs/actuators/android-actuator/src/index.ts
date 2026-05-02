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
} from '@agent/core';
import type { MobileAppProfile } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ANDROID_UI_DEFAULTS_PATH = pathResolver.knowledge('public/orchestration/android-ui-defaults.json');

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

interface AndroidAction {
  action: 'pipeline';
  steps: PipelineStep[];
  options?: {
    serial?: string;
    timeout_ms?: number;
    max_steps?: number;
    artifacts_dir?: string;
  };
  context?: Record<string, any>;
}

async function handleAction(input: AndroidAction) {
  if (input.action !== 'pipeline') {
    throw new Error(`Unsupported action: ${input.action}`);
  }
  return executePipeline(input.steps || [], input.options || {}, input.context || {});
}

async function executePipeline(steps: PipelineStep[], options: AndroidAction['options'] = {}, initialCtx: Record<string, any> = {}) {
  const rootDir = pathResolver.rootDir();
  const artifactsDir = path.resolve(
    rootDir,
    options?.artifacts_dir || pathResolver.sharedTmp(`actuators/android-actuator/session_${Date.now()}`),
  );
  if (!safeExistsSync(artifactsDir)) safeMkdir(artifactsDir, { recursive: true });

  let ctx: Record<string, any> = {
    ...initialCtx,
    timestamp: new Date().toISOString(),
    artifacts_dir: artifactsDir,
    android_serial: options?.serial || initialCtx.android_serial || '',
  };

  const resolve = (val: any): any => resolveVars(val, ctx);

  const results: Array<{ op: string; status: 'success' | 'failed'; error?: string }> = [];

  for (const step of steps) {
    try {
      logger.info(`  [ANDROID_PIPELINE] ${step.type}:${step.op}...`);
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
          logger.warn(`[ANDROID_PIPELINE] Unsupported step type: ${step.type}`);
      }
      results.push({ op: step.op, status: 'success' });
    } catch (error: any) {
      logger.error(`  [ANDROID_PIPELINE] Step failed (${step.op}): ${error.message}`);
      results.push({ op: step.op, status: 'failed', error: error.message });
      break;
    }
  }

  if (initialCtx.context_path) {
    safeWriteFile(path.resolve(rootDir, initialCtx.context_path), JSON.stringify(ctx, null, 2));
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
  options?: AndroidAction['options'],
) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'read_text_file': {
      const sourcePath = path.resolve(rootDir, resolve(params.path));
      const content = safeReadFile(sourcePath, { encoding: 'utf8' }) as string;
      return { ...ctx, [params.export_as || 'last_text']: content };
    }
    case 'read_json': {
      const sourcePath = path.resolve(rootDir, resolve(params.path));
      const content = safeReadFile(sourcePath, { encoding: 'utf8' }) as string;
      const parsed = JSON.parse(content);
      if (params.validate_as === 'mobile-app-profile') {
        assertValidMobileAppProfile(parsed, sourcePath);
      }
      return { ...ctx, [params.export_as || 'last_json']: parsed };
    }
    case 'adb_health_check': {
      const health = collectAdbHealth(ctx, options);
      return { ...ctx, [params.export_as || 'adb_health']: health, adb_available: health.available, android_serial: health.selected_serial || ctx.android_serial };
    }
    case 'capture_foreground_activity': {
      ensureAdbAvailable(ctx, options);
      const serial = resolveSerial(ctx, options, params);
      const output = runAdb(['shell', 'dumpsys', 'activity', 'activities'], serial, options);
      const resumedLine = output
        .split('\n')
        .find((line) => line.includes('mResumedActivity') || line.includes('topResumedActivity'));
      return {
        ...ctx,
        [params.export_as || 'foreground_activity']: {
          summary: resumedLine?.trim() || '',
          raw_excerpt: output.slice(0, 4000),
        },
      };
    }
    case 'capture_runtime_session_handoff': {
      ensureAdbAvailable(ctx, options);
      const serial = resolveSerial(ctx, options, params);
      const profile = resolveAppProfile(params, ctx);
      const devicePath = String(
        resolve(params.device_path || profile?.webview?.runtime_export?.android_device_path || ''),
      ).trim();
      if (!devicePath) {
        throw new Error('capture_runtime_session_handoff requires params.device_path or app_profile.webview.runtime_export.android_device_path');
      }
      const outPath = path.resolve(
        rootDir,
        resolve(params.path || path.join(ctx.artifacts_dir, `android-runtime-session-handoff-${Date.now()}.json`)),
      );
      ensureParentDir(outPath);
      runAdb(['pull', devicePath, outPath], serial, options);
      const content = safeReadFile(outPath, { encoding: 'utf8' }) as string;
      const parsed = JSON.parse(content);
      return {
        ...ctx,
        [params.export_as || 'runtime_session_handoff']: parsed,
        runtime_session_handoff_path: outPath,
      };
    }
    case 'extract_ui_tree': {
      ensureAdbAvailable(ctx, options);
      const outPath = path.resolve(rootDir, resolve(params.path || path.join(ctx.artifacts_dir, `ui-tree-${Date.now()}.xml`)));
      ensureParentDir(outPath);
      const remotePath = `/sdcard/kyberion-ui-${Date.now()}.xml`;
      const serial = resolveSerial(ctx, options, params);
      runAdb(['shell', 'uiautomator', 'dump', remotePath], serial, options);
      runAdb(['pull', remotePath, outPath], serial, options);
      safeCleanupRemote(serial, remotePath, options);
      const xml = safeReadFile(outPath, { encoding: 'utf8' }) as string;
      return {
        ...ctx,
        [params.export_as || 'last_ui_tree']: xml,
        last_ui_tree_path: outPath,
      };
    }
    default:
      logger.warn(`[ANDROID_CAPTURE] Unknown capture op: ${op}`);
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
    case 'summarize_ui_tree': {
      const xml = resolveUiTreeSource(params, ctx, resolve);
      const nodes = parseUiTreeNodes(xml);
      const summary = {
        node_count: nodes.length,
        clickable_count: nodes.filter((node) => node.clickable).length,
        editable_count: nodes.filter((node) => node.className.includes('EditText') || node.resourceId.includes('input')).length,
        texts: nodes
          .map((node) => node.text)
          .filter(Boolean)
          .slice(0, params.max_texts || 20),
        resource_ids: nodes
          .map((node) => node.resourceId)
          .filter(Boolean)
          .slice(0, params.max_resource_ids || 20),
      };
      return { ...ctx, [params.export_as || 'ui_tree_summary']: summary };
    }
    case 'find_ui_nodes': {
      const xml = resolveUiTreeSource(params, ctx, resolve);
      const matches = matchUiNodes(parseUiTreeNodes(xml), params, resolve);
      return { ...ctx, [params.export_as || 'ui_node_matches']: matches };
    }
    default:
      logger.warn(`[ANDROID_TRANSFORM] Unknown transform op: ${op}`);
      return ctx;
  }
}

async function opApply(
  op: string,
  params: any,
  ctx: Record<string, any>,
  resolve: (val: any) => any,
  options?: AndroidAction['options'],
) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'launch_app': {
      ensureAdbAvailable(ctx, options);
      const serial = resolveSerial(ctx, options, params);
      const component = resolve(params.component);
      if (!component) throw new Error('launch_app requires params.component, e.g. com.example/.MainActivity');
      const output = runAdb(['shell', 'am', 'start', '-n', component], serial, options);
      return { ...ctx, last_launch_output: output, android_serial: serial || ctx.android_serial };
    }
    case 'open_deep_link': {
      ensureAdbAvailable(ctx, options);
      const serial = resolveSerial(ctx, options, params);
      const url = resolve(params.url);
      if (!url) throw new Error('open_deep_link requires params.url');
      const args = ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url];
      if (params.package) args.push(String(resolve(params.package)));
      const output = runAdb(args, serial, options);
      return { ...ctx, last_deep_link_output: output };
    }
    case 'tap': {
      ensureAdbAvailable(ctx, options);
      const serial = resolveSerial(ctx, options, params);
      runAdb(['shell', 'input', 'tap', String(resolve(params.x)), String(resolve(params.y))], serial, options);
      return ctx;
    }
    case 'tap_ui_node': {
      const target = resolveTapTarget(params, ctx, resolve);
      const tapResult = {
        index: target.index,
        text: target.text,
        resourceId: target.resourceId,
        className: target.className,
        bounds: target.bounds,
        x: target.center.x,
        y: target.center.y,
      };

      if (params.dry_run === true) {
        return { ...ctx, [params.export_as || 'last_tap_target']: tapResult };
      }

      ensureAdbAvailable(ctx, options);
      const serial = resolveSerial(ctx, options, params);
      runAdb(['shell', 'input', 'tap', String(target.center.x), String(target.center.y)], serial, options);
      return { ...ctx, [params.export_as || 'last_tap_target']: tapResult };
    }
    case 'input_text_into_ui_node': {
      const target = resolveTapTarget(selectorParamsFromInput(params), ctx, resolve);
      const text = String(resolve(params.text || ''));
      if (!text.trim()) throw new Error('input_text_into_ui_node requires params.text');

      const inputResult = {
        index: target.index,
        text: target.text,
        resourceId: target.resourceId,
        className: target.className,
        bounds: target.bounds,
        x: target.center.x,
        y: target.center.y,
        input_text: text,
      };

      if (params.dry_run === true) {
        return { ...ctx, [params.export_as || 'last_input_target']: inputResult };
      }

      ensureAdbAvailable(ctx, options);
      const serial = resolveSerial(ctx, options, params);
      runAdb(['shell', 'input', 'tap', String(target.center.x), String(target.center.y)], serial, options);
      const preDelayMs = Number(resolve(params.pre_input_delay_ms || 250));
      if (preDelayMs > 0) sleep(preDelayMs);
      runAdb(['shell', 'input', 'text', normalizeAdbInputText(text)], serial, options);
      return { ...ctx, [params.export_as || 'last_input_target']: inputResult };
    }
    case 'fill_login_form': {
      const formPlan = buildLoginFormPlan(params, ctx, resolve);

      if (params.dry_run === true) {
        return { ...ctx, [params.export_as || 'last_login_form_plan']: formPlan };
      }

      ensureAdbAvailable(ctx, options);
      const serial = resolveSerial(ctx, options, params);
      runAdb(['shell', 'input', 'tap', String(formPlan.email_field.x), String(formPlan.email_field.y)], serial, options);
      sleep(Number(resolve(params.pre_input_delay_ms || 200)));
      runAdb(['shell', 'input', 'text', normalizeAdbInputText(formPlan.email)], serial, options);
      runAdb(['shell', 'input', 'tap', String(formPlan.password_field.x), String(formPlan.password_field.y)], serial, options);
      sleep(Number(resolve(params.pre_input_delay_ms || 200)));
      runAdb(['shell', 'input', 'text', normalizeAdbInputText(formPlan.password)], serial, options);
      if (params.submit !== false) {
        runAdb(['shell', 'input', 'tap', String(formPlan.submit_button.x), String(formPlan.submit_button.y)], serial, options);
      }
      return { ...ctx, [params.export_as || 'last_login_form_plan']: formPlan };
    }
    case 'swipe': {
      ensureAdbAvailable(ctx, options);
      const serial = resolveSerial(ctx, options, params);
      runAdb(
        [
          'shell',
          'input',
          'swipe',
          String(resolve(params.x1)),
          String(resolve(params.y1)),
          String(resolve(params.x2)),
          String(resolve(params.y2)),
          String(resolve(params.duration_ms || 250)),
        ],
        serial,
        options,
      );
      return ctx;
    }
    case 'input_text': {
      ensureAdbAvailable(ctx, options);
      const serial = resolveSerial(ctx, options, params);
      const text = normalizeAdbInputText(String(resolve(params.text || '')));
      runAdb(['shell', 'input', 'text', text], serial, options);
      return ctx;
    }
    case 'capture_screen': {
      ensureAdbAvailable(ctx, options);
      const serial = resolveSerial(ctx, options, params);
      const outPath = path.resolve(rootDir, resolve(params.path || path.join(ctx.artifacts_dir, `screen-${Date.now()}.png`)));
      ensureParentDir(outPath);
      const remotePath = `/sdcard/kyberion-screen-${Date.now()}.png`;
      runAdb(['shell', 'screencap', '-p', remotePath], serial, options);
      runAdb(['pull', remotePath, outPath], serial, options);
      safeCleanupRemote(serial, remotePath, options);
      return { ...ctx, last_screenshot_path: outPath };
    }
    case 'wait_for_ui_text': {
      ensureAdbAvailable(ctx, options);
      const serial = resolveSerial(ctx, options, params);
      const target = String(resolve(params.text || '')).trim().toLowerCase();
      if (!target) throw new Error('wait_for_ui_text requires params.text');

      const timeoutMs = Number(resolve(params.timeout_ms || options?.timeout_ms || 15000));
      const intervalMs = Number(resolve(params.interval_ms || 1000));
      const startedAt = Date.now();

      while (Date.now() - startedAt <= timeoutMs) {
        const xml = dumpUiTree(serial, options);
        const nodes = parseUiTreeNodes(xml);
        const found = nodes.some((node) =>
          node.text.toLowerCase().includes(target) || node.contentDesc.toLowerCase().includes(target),
        );
        if (found) {
          return { ...ctx, last_ui_tree: xml, wait_for_ui_text_found: true, wait_for_ui_text_value: resolve(params.text) };
        }
        sleep(intervalMs);
      }

      throw new Error(`Timed out waiting for UI text: ${resolve(params.text)}`);
    }
    case 'wait_for_ui_node': {
      ensureAdbAvailable(ctx, options);
      const serial = resolveSerial(ctx, options, params);
      const timeoutMs = Number(resolve(params.timeout_ms || options?.timeout_ms || 15000));
      const intervalMs = Number(resolve(params.interval_ms || 1000));
      const startedAt = Date.now();

      while (Date.now() - startedAt <= timeoutMs) {
        const xml = dumpUiTree(serial, options);
        const matches = matchUiNodes(parseUiTreeNodes(xml), params, resolve);
        if (matches.length > 0) {
          return {
            ...ctx,
            last_ui_tree: xml,
            [params.export_as || 'wait_for_ui_node_match']: matches[Number(resolve(params.match_index || 0))] || matches[0],
            wait_for_ui_node_found: true,
          };
        }
        sleep(intervalMs);
      }

      throw new Error(`Timed out waiting for UI node: ${describeUiSelector(params, resolve)}`);
    }
    case 'authenticate_with_passkey': {
      const profile = resolveAppProfile(params, ctx);
      const defaults = loadAndroidUiDefaults();
      const selector = {
        ...params,
        text: params.selector_text || params.text || profile?.selectors?.passkey?.trigger?.text || defaults.passkey?.trigger?.text,
        resource_id: params.selector_resource_id || params.resource_id || profile?.selectors?.passkey?.trigger?.resource_id,
        class_name: params.selector_class_name || params.class_name || profile?.selectors?.passkey?.trigger?.class_name || defaults.passkey?.trigger?.class_name,
        package_name: params.selector_package_name || params.package_name || profile?.package_name,
      };
      const target = resolveTapTarget(selector, ctx, resolve);
      const passkeyPlan = {
        trigger: {
          index: target.index,
          text: target.text,
          resourceId: target.resourceId,
          className: target.className,
          bounds: target.bounds,
          x: target.center.x,
          y: target.center.y,
        },
      };

      if (params.dry_run === true) {
        return { ...ctx, [params.export_as || 'last_passkey_plan']: passkeyPlan };
      }

      ensureAdbAvailable(ctx, options);
      const serial = resolveSerial(ctx, options, params);
      runAdb(['shell', 'input', 'tap', String(target.center.x), String(target.center.y)], serial, options);
      return { ...ctx, [params.export_as || 'last_passkey_plan']: passkeyPlan };
    }
    case 'emit_session_handoff': {
      const handoff = buildSessionHandoffArtifact(params, ctx, resolve, 'android');
      const outPath = path.resolve(rootDir, resolve(params.path || path.join(ctx.artifacts_dir, `android-session-handoff-${Date.now()}.json`)));
      ensureParentDir(outPath);
      safeWriteFile(outPath, JSON.stringify(handoff, null, 2));
      return {
        ...ctx,
        [params.export_as || 'session_handoff']: handoff,
        session_handoff_path: outPath,
      };
    }
    case 'log':
      logger.info(`[ANDROID_LOG] ${resolve(params.message)}`);
      return ctx;
    default:
      logger.warn(`[ANDROID_APPLY] Unknown apply op: ${op}`);
      return ctx;
  }
}

function collectAdbHealth(ctx: Record<string, any>, options?: AndroidAction['options']) {
  try {
    const version = safeExec('adb', ['version'], { timeoutMs: options?.timeout_ms || 15000 }).trim();
    const devicesOutput = safeExec('adb', ['devices'], { timeoutMs: options?.timeout_ms || 15000 }).trim();
    const devices = parseAdbDevices(devicesOutput);
    const preferredSerial = options?.serial || ctx.android_serial || '';
    const selectedSerial = preferredSerial || devices.find((device) => device.state === 'device')?.serial || '';
    return {
      available: true,
      version,
      devices,
      selected_serial: selectedSerial,
    };
  } catch (error: any) {
    return {
      available: false,
      error: error.message,
      devices: [],
      selected_serial: '',
    };
  }
}

function ensureAdbAvailable(ctx: Record<string, any>, options?: AndroidAction['options']) {
  const health = collectAdbHealth(ctx, options);
  if (!health.available) {
    throw new Error(`adb is not available: ${health.error}`);
  }
}

function resolveSerial(ctx: Record<string, any>, options: AndroidAction['options'] | undefined, params: any): string {
  return String(resolvePrimitive(params?.serial) || options?.serial || ctx.android_serial || '').trim();
}

function resolvePrimitive(val: any): any {
  return val;
}

function runAdb(args: string[], serial: string, options?: AndroidAction['options']): string {
  const finalArgs = serial ? ['-s', serial, ...args] : args;
  return safeExec('adb', finalArgs, { timeoutMs: options?.timeout_ms || 30000 }).trim();
}

function parseAdbDevices(output: string): Array<{ serial: string; state: string }> {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of devices attached'))
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial, state: state || 'unknown' };
    });
}

function normalizeAdbInputText(input: string): string {
  return input
    .replace(/ /g, '%s')
    .replace(/[&<>|;$`"']/g, '')
    .trim();
}

function safeCleanupRemote(serial: string, remotePath: string, options?: AndroidAction['options']) {
  try {
    runAdb(['shell', 'rm', '-f', remotePath], serial, options);
  } catch {
    // cleanup is best-effort only
  }
}

function dumpUiTree(serial: string, options?: AndroidAction['options']): string {
  const remotePath = `/sdcard/kyberion-ui-${Date.now()}.xml`;
  try {
    runAdb(['shell', 'uiautomator', 'dump', remotePath], serial, options);
    const content = runAdb(['shell', 'cat', remotePath], serial, options);
    return content;
  } finally {
    safeCleanupRemote(serial, remotePath, options);
  }
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

function resolveUiTreeSource(params: any, ctx: Record<string, any>, resolve: (val: any) => any): string {
  if (params.from) {
    const value = ctx[String(params.from)];
    if (typeof value === 'string' && value.trim()) return value;
  }

  const inline = resolve(params.source);
  if (typeof inline === 'string' && inline.trim()) {
    return inline;
  }

  if (typeof ctx.last_ui_tree === 'string' && ctx.last_ui_tree.trim()) {
    return ctx.last_ui_tree;
  }

  throw new Error('summarize_ui_tree/find_ui_nodes requires params.from, params.source, or ctx.last_ui_tree');
}

interface AndroidUiNode {
  index: number;
  text: string;
  resourceId: string;
  className: string;
  packageName: string;
  contentDesc: string;
  bounds: string;
  clickable: boolean;
  enabled: boolean;
}

interface AndroidTapTarget extends AndroidUiNode {
  center: { x: number; y: number };
}

function parseUiTreeNodes(xml: string): AndroidUiNode[] {
  const nodes: AndroidUiNode[] = [];
  const regex = /<node\b([^>]*)\/>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    const attrs = match[1];
    nodes.push({
      index: Number(readXmlAttr(attrs, 'index') || nodes.length),
      text: decodeXml(readXmlAttr(attrs, 'text') || ''),
      resourceId: decodeXml(readXmlAttr(attrs, 'resource-id') || ''),
      className: decodeXml(readXmlAttr(attrs, 'class') || ''),
      packageName: decodeXml(readXmlAttr(attrs, 'package') || ''),
      contentDesc: decodeXml(readXmlAttr(attrs, 'content-desc') || ''),
      bounds: readXmlAttr(attrs, 'bounds') || '',
      clickable: readXmlAttr(attrs, 'clickable') === 'true',
      enabled: readXmlAttr(attrs, 'enabled') !== 'false',
    });
  }
  return nodes;
}

function resolveTapTarget(
  params: any,
  ctx: Record<string, any>,
  resolve: (val: any) => any,
): AndroidTapTarget {
  let candidates: AndroidUiNode[] = [];

  if (params.from) {
    const fromValue = ctx[String(params.from)];
    if (Array.isArray(fromValue)) {
      candidates = matchUiNodes(fromValue as AndroidUiNode[], params, resolve);
    } else if (typeof fromValue === 'string') {
      candidates = matchUiNodes(parseUiTreeNodes(fromValue), params, resolve);
    }
  }

  if (candidates.length === 0) {
    const xml = resolveUiTreeSource(params, ctx, resolve);
    candidates = matchUiNodes(parseUiTreeNodes(xml), params, resolve);
  }

  if (candidates.length === 0) {
    throw new Error('tap_ui_node could not resolve any candidate node');
  }

  const index = Number(resolve(params.match_index || 0));
  const selected = candidates[index];
  if (!selected) {
    throw new Error(`tap_ui_node match_index is out of range: ${index}`);
  }

  const center = boundsCenter(selected.bounds);
  return { ...selected, center };
}

function selectorParamsFromInput(params: any): any {
  const appProfile = params.app_profile || params.profile;
  if (params.selector && typeof params.selector === 'object') {
    return { ...params, ...params.selector };
  }
  return {
    ...params,
    text: params.selector_text,
    resource_id: params.selector_resource_id || params.resource_id || appProfile?.selectors?.login?.email?.resource_id,
    class_name: params.selector_class_name || params.class_name || appProfile?.selectors?.login?.email?.class_name,
    package_name: params.selector_package_name || params.package_name || appProfile?.package_name,
  };
}

function buildLoginFormPlan(
  params: any,
  ctx: Record<string, any>,
  resolve: (val: any) => any,
): {
  email: string;
  password: string;
  email_field: ReturnType<typeof serializeTapTarget>;
  password_field: ReturnType<typeof serializeTapTarget>;
  submit_button: ReturnType<typeof serializeTapTarget>;
} {
  const email = String(resolve(params.email || ''));
  const password = String(resolve(params.password || ''));
  if (!email.trim()) throw new Error('fill_login_form requires params.email');
  if (!password.trim()) throw new Error('fill_login_form requires params.password');
  const profile = resolveAppProfile(params, ctx);
  const defaults = loadAndroidUiDefaults();

  const emailTarget = resolveTapTarget(
    {
      ...params,
      text: params.email_selector_text || profile?.selectors?.login?.email?.text || defaults.login?.email?.text,
      resource_id: params.email_selector_resource_id || profile?.selectors?.login?.email?.resource_id || defaults.login?.email?.resource_id,
      class_name: params.email_selector_class_name || profile?.selectors?.login?.email?.class_name || defaults.login?.email?.class_name,
      package_name: params.email_selector_package_name || profile?.package_name,
    },
    ctx,
    resolve,
  );
  const passwordTarget = resolveTapTarget(
    {
      ...params,
      text: params.password_selector_text || profile?.selectors?.login?.password?.text || defaults.login?.password?.text,
      resource_id: params.password_selector_resource_id || profile?.selectors?.login?.password?.resource_id || defaults.login?.password?.resource_id,
      class_name: params.password_selector_class_name || profile?.selectors?.login?.password?.class_name || defaults.login?.password?.class_name,
      package_name: params.password_selector_package_name || profile?.package_name,
    },
    ctx,
    resolve,
  );
  const submitTarget = resolveTapTarget(
    {
      ...params,
      text: params.submit_selector_text || profile?.selectors?.login?.submit?.text || defaults.login?.submit?.text,
      resource_id: params.submit_selector_resource_id || profile?.selectors?.login?.submit?.resource_id || defaults.login?.submit?.resource_id,
      class_name: params.submit_selector_class_name || profile?.selectors?.login?.submit?.class_name || defaults.login?.submit?.class_name,
      package_name: params.submit_selector_package_name || profile?.package_name,
    },
    ctx,
    resolve,
  );

  return {
    email,
    password,
    email_field: serializeTapTarget(emailTarget),
    password_field: serializeTapTarget(passwordTarget),
    submit_button: serializeTapTarget(submitTarget),
  };
}

function serializeTapTarget(target: AndroidTapTarget) {
  return {
    index: target.index,
    text: target.text,
    resourceId: target.resourceId,
    className: target.className,
    bounds: target.bounds,
    x: target.center.x,
    y: target.center.y,
  };
}

function loadAndroidUiDefaults(): any {
  if (safeExistsSync(ANDROID_UI_DEFAULTS_PATH)) {
    try {
      return JSON.parse(safeReadFile(ANDROID_UI_DEFAULTS_PATH, { encoding: 'utf8' }) as string);
    } catch (_) {}
  }
  return {
    login: {
      email: { resource_id: 'email', class_name: 'EditText' },
      password: { resource_id: 'password', class_name: 'EditText' },
      submit: { text: 'sign in', resource_id: 'sign_in', class_name: 'Button' },
    },
    passkey: {
      trigger: { text: 'passkey', class_name: 'Button' },
    },
  };
}

function buildSessionHandoffArtifact(
  params: any,
  ctx: Record<string, any>,
  resolve: (val: any) => any,
  platform: 'android' | 'ios',
) {
  const profile = resolveAppProfile(params, ctx);
  const targetUrl = String(
    resolve(params.target_url || profile?.webview?.session_handoff?.target_url || profile?.webview?.entry_url || ''),
  ).trim();
  if (!targetUrl) throw new Error('emit_session_handoff requires params.target_url or app_profile.webview.session_handoff.target_url');

  const localStorage = resolveObjectRef(params.local_storage_from, ctx) || resolve(params.local_storage) || {};
  const sessionStorage = resolveObjectRef(params.session_storage_from, ctx) || resolve(params.session_storage) || {};
  const headers = resolveObjectRef(params.headers_from, ctx) || resolve(params.headers) || {};
  const cookies = resolveObjectRef(params.cookies_from, ctx) || resolve(params.cookies) || [];

  return {
    kind: 'webview-session-handoff',
    target_url: targetUrl,
    origin: safeOrigin(targetUrl),
    browser_session_id: String(resolve(params.browser_session_id || profile?.webview?.session_handoff?.browser_session_id || `${platform}-webview`)),
    prefer_persistent_context:
      params.prefer_persistent_context ?? profile?.webview?.session_handoff?.prefer_persistent_context ?? true,
    cookies,
    local_storage: localStorage,
    session_storage: sessionStorage,
    headers,
    source: {
      platform,
      app_id: profile?.app_id || ctx.app_id || `${platform}-app`,
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

function matchUiNodes(
  nodes: AndroidUiNode[],
  params: any,
  resolve: (val: any) => any,
): AndroidUiNode[] {
  const text = String(resolve(params.text || '')).trim().toLowerCase();
  const resourceId = String(resolve(params.resource_id || '')).trim().toLowerCase();
  const className = String(resolve(params.class_name || '')).trim().toLowerCase();
  const packageName = String(resolve(params.package_name || '')).trim().toLowerCase();
  const clickableOnly = params.clickable === true;
  const enabledOnly = params.enabled !== false;

  return nodes.filter((node) => {
    if (text && !node.text.toLowerCase().includes(text) && !node.contentDesc.toLowerCase().includes(text)) return false;
    if (resourceId && !node.resourceId.toLowerCase().includes(resourceId)) return false;
    if (className && !node.className.toLowerCase().includes(className)) return false;
    if (packageName && !node.packageName.toLowerCase().includes(packageName)) return false;
    if (clickableOnly && !node.clickable) return false;
    if (enabledOnly && !node.enabled) return false;
    return true;
  });
}

function describeUiSelector(params: any, resolve: (val: any) => any): string {
  const parts = [
    resolve(params.text) ? `text=${resolve(params.text)}` : '',
    resolve(params.resource_id) ? `resource_id=${resolve(params.resource_id)}` : '',
    resolve(params.class_name) ? `class_name=${resolve(params.class_name)}` : '',
    resolve(params.package_name) ? `package_name=${resolve(params.package_name)}` : '',
  ].filter(Boolean);
  return parts.join(', ') || 'unspecified selector';
}

function boundsCenter(bounds: string): { x: number; y: number } {
  const match = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) {
    throw new Error(`Invalid bounds: ${bounds}`);
  }
  const [, x1, y1, x2, y2] = match.map(Number);
  return {
    x: Math.round((x1 + x2) / 2),
    y: Math.round((y1 + y2) / 2),
  };
}

function readXmlAttr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`${escapeRegExp(name)}="([^"]*)"`, 'i'));
  return match?.[1];
}

function decodeXml(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy wait is acceptable here for a small actuator MVP
  }
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
