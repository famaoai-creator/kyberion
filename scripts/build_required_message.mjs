/**
 * CU-06: the one "build first" hint shared by every bootstrap entry that runs
 * compiled `dist/` output (kyberion_cli_entry.mjs, run_built.mjs). Bootstrap
 * code runs before `pnpm build`, so it cannot load @agent/core or the
 * vocabulary catalog — keep this module dependency-free.
 */

/** @param {string} missing repo-relative path of the missing build output */
export function formatBuildRequiredMessage(missing) {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  const nodeHint =
    nodeMajor < 24
      ? `This process is Node ${process.versions.node}; package.json engines require Node >=24. Use nvm install 24 && nvm use 24, then rebuild.`
      : `Node ${process.versions.node} meets engines (>=24).`;
  return [
    `Kyberion needs a build first (missing ${missing}). Run \`pnpm build\`, then retry.`,
    nodeHint,
    'Cloud Agent / fresh VM: see docs/developer/CLOUD_AGENT_ENVIRONMENT.md',
    'Discovery without build: pnpm capabilities',
    '  or: pnpm kyberion list',
    'Execution: pnpm build && pnpm kyberion <command>',
    "Doctor: pnpm run doctor  (not bare `pnpm doctor`, which is pnpm's own doctor)",
  ].join('\n');
}

/**
 * True when an import failed only because compiled output is absent
 * (the entry itself or a workspace package's dist/ build).
 * @param {unknown} error
 */
export function isMissingBuildError(error) {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = /** @type {{ code?: unknown; message?: unknown }} */ (error);
  return code === 'ERR_MODULE_NOT_FOUND' && /[\\/]dist[\\/]/u.test(String(message ?? ''));
}
