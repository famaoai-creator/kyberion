import { logger, safeExecResult, secureFetch } from '@agent/core';
async function runStepHooks(hooks, ctx, phase, loadActuatorDispatch) {
  for (const hook of hooks) {
    const rejected = await runOneHook(hook, ctx, phase, loadActuatorDispatch);
    if (!rejected) continue;
    const decision = hook.on_reject ?? 'abort';
    const label = hook.label ?? `${phase}:${hook.type}`;
    if (decision === 'warn') {
      logger.warn(`[pipeline:hook] ${label} rejected but on_reject=warn; continuing`);
      continue;
    }
    if (phase === 'after' && decision === 'skip') {
      logger.warn(
        `[pipeline:hook] ${label} rejected with on_reject=skip after step; treating as continue`
      );
      continue;
    }
    return decision;
  }
  return 'continue';
}
async function runOneHook(hook, ctx, phase, loadActuatorDispatch) {
  const label = hook.label ?? `${phase}:${hook.type}`;
  try {
    if (hook.type === 'actuator_op') {
      return await runActuatorHook(hook, ctx, loadActuatorDispatch);
    }
    if (hook.type === 'http') {
      return await runHttpHook(hook, ctx);
    }
    if (hook.type === 'command') {
      return runCommandHook(hook, ctx);
    }
    throw new Error(`unsupported hook type: ${hook.type}`);
  } catch (err) {
    const hookTarget = hook.url || hook.cmd || hook.op || '';
    const targetSuffix = hookTarget ? ` \u2192 ${hookTarget}` : '';
    logger.warn(
      `[pipeline:hook] ${label} failed (${phase} ${hook.type}${targetSuffix}): ${err.message || err}`
    );
    return true;
  }
}
async function runActuatorHook(hook, ctx, loadActuatorDispatch) {
  if (!hook.op) throw new Error('actuator hook requires op');
  const [domain, action] = hook.op.split(':', 2);
  if (!domain || !action) throw new Error(`invalid actuator hook op: ${hook.op}`);
  const dispatch = await loadActuatorDispatch(domain);
  const params = resolveParamsRecursive(hook.params ?? {}, ctx);
  const result = await dispatch(action, params, ctx);
  if (!result.handled) throw new Error(`actuator hook was not handled: ${hook.op}`);
  const resultCtx = result.ctx ?? {};
  return (
    resultCtx.decision === 'rejected' ||
    resultCtx.decision === 'abort' ||
    resultCtx.approved === false
  );
}
async function runHttpHook(hook, ctx) {
  if (!hook.url) throw new Error('http hook requires url');
  const response = await secureFetch({
    url: String(resolveVars(hook.url, ctx)),
    method: hook.method ?? 'GET',
    data: resolveParamsRecursive(hook.body, ctx),
    headers: resolveParamsRecursive(hook.headers, ctx),
  });
  return (
    response?.decision === 'abort' ||
    response?.decision === 'rejected' ||
    response?.approved === false
  );
}
function runCommandHook(hook, ctx) {
  if (!hook.cmd) throw new Error('command hook requires cmd');
  const cmd = String(resolveVars(hook.cmd, ctx));
  const result = safeExecResult('bash', ['-lc', cmd]);
  if (result.status === 0) return false;
  if (result.status === 2) return true;
  throw new Error(result.stderr || result.error?.message || `command exited with ${result.status}`);
}
function resolveParamsRecursive(value, ctx) {
  if (Array.isArray(value)) return value.map((item) => resolveParamsRecursive(item, ctx));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveParamsRecursive(entry, ctx)])
    );
  }
  return resolveVars(value, ctx);
}
function resolveVars(value, ctx) {
  if (typeof value !== 'string') return value;
  const exact = value.match(/^{{\s*([^}]+)\s*}}$/);
  if (exact) return readPath(ctx, exact[1].trim());
  return value.replace(/{{\s*([^}]+)\s*}}/g, (_, key) => {
    const resolved = readPath(ctx, key.trim());
    return resolved === void 0 || resolved === null ? '' : String(resolved);
  });
}
function readPath(source, dottedPath) {
  return dottedPath.split('.').reduce((current, segment) => {
    if (current && typeof current === 'object' && segment in current) {
      return current[segment];
    }
    return void 0;
  }, source);
}
export { runStepHooks };
