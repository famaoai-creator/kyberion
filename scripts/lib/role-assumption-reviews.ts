/**
 * RN-02 hand-reviewed data-flow facts for scripts/analyze_role_assumptions.ts.
 * Every entry names why the reference graph cannot see the fact and, for an
 * infeasibility, the test that pins it. A site missing here stays an
 * "any role" site in the report.
 */
import { readSafeJsonFile } from './json-input.js';
import type { Workspace } from './role-assumption-workspace.js';

/**
 * Dynamic imports whose specifier is computed at runtime, reviewed by hand:
 * the modules they can load (repo-relative, `*` matches one path segment).
 * An unreviewed computed import is reported as an "any role" site.
 */
export const REVIEWED_DYNAMIC_IMPORTS: Record<string, { modules: string[]; rationale: string }> =
  {};

/**
 * Child processes whose command is computed at runtime and that may inherit
 * SYSTEM_ROLE, reviewed by hand. `targets` lists the Kyberion entry points the
 * child can run (walked as entries of the same system role); an empty list
 * means the child only runs external binaries. An unreviewed site whose
 * entry point cannot be resolved is reported as an "any role" site.
 */
/**
 * Assumptions the reference graph reaches but that cannot run for a system
 * role because of data flow the graph does not model. Each entry names the
 * test that pins the infeasibility; the report lists them separately and they
 * are not counted as reachable.
 */
export const REVIEWED_INFEASIBLE_ASSUMPTIONS: Array<{
  systemRoles: string[];
  role: string;
  site: string;
  rationale: string;
}> = [
  {
    systemRoles: ['computer_surface', 'presence_studio'],
    role: 'chronos_token_registry_reader',
    site: 'libs/core/authn-providers.ts#loadRegistrations',
    rationale:
      'TR-01: computer-surface/auth.ts and presence-studio/security.ts resolve viewers with `registrations: null`, so the registry-token provider never reads the Chronos token registry; pinned by libs/core/chronos-token-registry-reader.test.ts',
  },
];

export interface ReviewedChildProcess {
  /** Repo-relative entry points (`*` matches one path segment) or a data-driven resolver. */
  targets: string[] | ((ws: Workspace) => string[]);
  rationale: string;
}

const EXTERNAL_BINARY = 'runs an external binary, never a Kyberion entry point';

export const REVIEWED_CHILD_PROCESSES: Record<string, ReviewedChildProcess> = {
  'libs/core/service/service-engine-execution.ts#executeServicePresetAlternative': {
    targets: [],
    rationale:
      'runs a service preset CLI alternative through safeExec with an env built only from the preset (buildChildEnv), so buildSafeExecEnv never passes SYSTEM_ROLE on',
  },
  'libs/actuators/service-actuator/src/service-actuator-helpers.ts#startService': {
    targets: ['libs/actuators/*/src/index.ts'],
    rationale:
      'starts `node dist/libs/actuators/<id>/src/index.js` for the ids of a caller-supplied service manifest with process.env: any actuator entry',
  },
  'libs/core/apple-intelligence-bridge.ts#defaultRunner': {
    targets: [],
    rationale: `Apple Foundation Models helper; ${EXTERNAL_BINARY}`,
  },
  'libs/core/pfc/PhysicalLayer.ts#checkBinary': {
    targets: [],
    rationale: `\`command -v\` / \`where\` probe; ${EXTERNAL_BINARY}`,
  },
  'libs/core/virtual/virtual-camera-bridge.ts#isAvailableCommand': {
    targets: [],
    rationale: `camera capture tool probe (imagesnap / ffmpeg); ${EXTERNAL_BINARY}`,
  },
  'libs/core/virtual/virtual-camera-bridge.ts#ensureBuiltinVirtualCameraCaptureBackends': {
    targets: [],
    rationale: `camera capture tools (imagesnap / ffmpeg / sips / cp); ${EXTERNAL_BINARY}`,
  },
  'presence/bridge/nexus-daemon.ts#dispatchFeedback': {
    targets: (ws) =>
      readSafeJsonFile<{ channels?: Array<{ connector_skill?: string }> }>(
        ws.abs('presence/bridge/channel-registry.json'),
        'channel registry'
      )
        .channels?.map((channel) => channel.connector_skill)
        .filter((skill): skill is string => !!skill)
        .map((skill) => `libs/actuators/${skill}/src/index.ts`) ?? [],
    rationale:
      'runs `node dist/libs/actuators/<connector_skill>/src/index.js` with process.env for the connector skills of presence/bridge/channel-registry.json',
  },
};

/**
 * Plain JavaScript modules the TypeScript program does not analyse, reviewed
 * as browser-only runtime code (repo-relative, `*` matches one path segment;
 * only .js / .mjs files of a match count).
 * The analyzer re-verifies each loaded file: it may only import other
 * reviewed modules by relative path and must not mention `require(`,
 * `node:`, `@agent/` or `withExecutionContext`; otherwise the load stays an
 * any-role site.
 */
export const REVIEWED_UNANALYSED_MODULES: Array<{ pattern: string; rationale: string }> = [
  {
    pattern: 'libs/shared-ui/vanilla/*',
    rationale:
      'framework-free browser renderers of the kyberion-base catalog (DOM only, typed by sibling .d.ts files); they never run Kyberion server code',
  },
];
