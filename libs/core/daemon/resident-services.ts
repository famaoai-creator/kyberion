/**
 * libs/core/daemon/resident-services.ts — desired vs installed resident services.
 *
 * `knowledge/product/governance/resident-services.json` declares which
 * DAEMON_SPECS entries a checkout keeps registered with the host service
 * manager. `planResidentServices` is the pure diff against what
 * installed-units.ts found on the host; `pnpm kyberion scheduler reconcile`
 * renders the desired units, calls the planner, and (with --apply) executes the
 * service-manager plans. The per-checkout record of what reconcile installed
 * lives in `active/shared/runtime/state/resident-services.json`.
 *
 * Rules (every one is a pure function of its inputs):
 *   - desired = required services + optional services named by --include,
 *     except a service whose owner_surface is enabled: surface-runtime runs it.
 *   - a legacy global unit owned by this checkout → migrate (uninstall legacy,
 *     install scoped) when desired, otherwise leave and report.
 *   - a scoped unit whose content hash or node path differs from the rendered
 *     unit → reinstall; equal → ok (idempotent: a second run plans nothing).
 *   - units owned by another checkout are reported, never touched.
 */
import { createHash } from 'node:crypto';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { knowledge, shared } from '../path-resolver.js';
import type { InstalledUnitDetail, InstalledUnitDetailsReport } from './installed-units.js';

export type ResidentServiceRequirement = 'required' | 'optional';

export interface ResidentServicePolicyEntry {
  id: string;
  requirement: ResidentServiceRequirement;
  owner_surface?: string;
  rationale: string;
}

export interface ResidentServicesPolicy {
  version: 1;
  description?: string;
  services: ResidentServicePolicyEntry[];
}

export const RESIDENT_SERVICES_POLICY_PATH = 'product/governance/resident-services.json';
export const RESIDENT_SERVICES_STATE_PATH = 'runtime/state/resident-services.json';

const policyCatalog = defineCatalog<ResidentServicesPolicy>({
  id: 'resident-services',
  path: () => knowledge(RESIDENT_SERVICES_POLICY_PATH),
  schema: knowledge('product/schemas/resident-services.schema.json'),
});

export function loadResidentServicesPolicy(): ResidentServicesPolicy {
  return policyCatalog.load();
}

/** What reconcile would install for one service on this checkout. */
export interface DesiredResidentUnit {
  id: string;
  /** Checkout-scoped label (com.kyberion.<id>.ws-<hash>). */
  label: string;
  /** Legacy global label of the same daemon (com.kyberion.<id>). */
  legacyLabel: string;
  unitSha256: string;
  nodePath: string;
}

export type ResidentServiceAction =
  'install' | 'migrate' | 'reinstall' | 'ok' | 'surface-owned' | 'not-requested' | 'unavailable';

export interface ResidentServicePlanItem {
  id: string;
  requirement: ResidentServiceRequirement;
  action: ResidentServiceAction;
  /** Scoped label reconcile manages. */
  label: string;
  reason: string;
  /** Legacy global unit of this checkout that a migrate removes. */
  legacyLabel?: string;
  /** Units of this checkout that stay as they are (e.g. optional, not included). */
  warnings: string[];
}

export interface ResidentServicesPlan {
  instanceId: string;
  repoRoot: string;
  platform: InstalledUnitDetailsReport['platform'];
  items: ResidentServicePlanItem[];
  /** Units another checkout owns — reported, never touched. */
  foreign: Array<Pick<InstalledUnitDetail, 'id' | 'label' | 'scope' | 'repoRoot' | 'loaded'>>;
  /** Units of this checkout that resident-services.json does not declare. */
  unmanaged: Array<Pick<InstalledUnitDetail, 'id' | 'label' | 'scope'>>;
  /** Host changes --apply would make (install + migrate + reinstall). */
  pendingChanges: number;
  note?: string;
}

export interface PlanResidentServicesInput {
  policy: ResidentServicesPolicy;
  installed: InstalledUnitDetailsReport;
  /** Surface ids enabled after the operator overlay. */
  enabledSurfaces: ReadonlySet<string>;
  /** Optional service ids the operator asked for (--include). */
  include?: readonly string[];
  /** Rendered unit per service id; absent → the platform cannot render it. */
  desired: Readonly<Record<string, DesiredResidentUnit | undefined>>;
}

export function planResidentServices(input: PlanResidentServicesInput): ResidentServicesPlan {
  const include = new Set(input.include ?? []);
  const declared = new Set(input.policy.services.map((service) => service.id));
  for (const id of include) {
    if (!declared.has(id))
      throw new Error(
        `[RESIDENT_SERVICE_UNKNOWN] --include ${id}: not declared in resident-services.json (known: ${[...declared].join(', ')})`
      );
  }
  const owned = input.installed.units.filter((unit) => unit.ownedByThisCheckout);
  const items: ResidentServicePlanItem[] = input.policy.services.map((service) => {
    const desired = input.desired[service.id];
    const scoped = owned.find((unit) => unit.id === service.id && unit.scope === 'scoped');
    const legacy = owned.find((unit) => unit.id === service.id && unit.scope === 'legacy');
    const label = desired?.label ?? scoped?.label ?? `com.kyberion.${service.id}`;
    const warnings: string[] = [];
    const base = { id: service.id, requirement: service.requirement, label, warnings };

    if (service.owner_surface && input.enabledSurfaces.has(service.owner_surface)) {
      for (const unit of [scoped, legacy]) {
        if (unit)
          warnings.push(
            `${unit.label} also runs this daemon while surface '${service.owner_surface}' is enabled — remove it with \`pnpm kyberion scheduler uninstall --daemon ${service.id}${unit.scope === 'legacy' ? ' --legacy-global' : ''} --apply\``
          );
      }
      return {
        ...base,
        action: 'surface-owned',
        reason: `surface '${service.owner_surface}' is enabled; surface-runtime runs this daemon`,
      };
    }

    const wanted = service.requirement === 'required' || include.has(service.id);
    if (!wanted) {
      if (legacy)
        warnings.push(
          `legacy unit ${legacy.label} of this checkout is left as is — pass --include ${service.id} to migrate it`
        );
      return {
        ...base,
        action: 'not-requested',
        reason: scoped
          ? `optional; ${scoped.label} is installed and left as is (--include ${service.id} keeps it current)`
          : `optional; pass --include ${service.id} to install it`,
      };
    }
    if (!desired) {
      return {
        ...base,
        action: 'unavailable',
        reason: `no service manager can render this unit on platform '${input.installed.platform}'`,
      };
    }
    if (legacy) {
      return {
        ...base,
        action: 'migrate',
        legacyLabel: legacy.label,
        reason: `legacy global unit ${legacy.label} runs this checkout; replace it with ${desired.label}`,
      };
    }
    if (!scoped) return { ...base, action: 'install', reason: `${desired.label} is not installed` };
    const drift: string[] = [];
    if (scoped.nodePath !== desired.nodePath)
      drift.push(`node path ${scoped.nodePath ?? 'unknown'} → ${desired.nodePath}`);
    if (scoped.unitSha256 !== desired.unitSha256) drift.push('unit content changed');
    if (drift.length > 0) return { ...base, action: 'reinstall', reason: drift.join('; ') };
    return {
      ...base,
      action: 'ok',
      reason: `${desired.label} is installed and current${scoped.loaded === false ? ' (not loaded — `pnpm kyberion scheduler start`)' : ''}`,
    };
  });

  return {
    instanceId: input.installed.instanceId,
    repoRoot: input.installed.repoRoot,
    platform: input.installed.platform,
    items,
    foreign: input.installed.units
      .filter((unit) => !unit.ownedByThisCheckout)
      .map(({ id, label, scope, repoRoot, loaded }) => ({ id, label, scope, repoRoot, loaded })),
    unmanaged: owned
      .filter((unit) => !declared.has(unit.id))
      .map(({ id, label, scope }) => ({ id, label, scope })),
    pendingChanges: items.filter((item) =>
      ['install', 'migrate', 'reinstall'].includes(item.action)
    ).length,
    ...(input.installed.note ? { note: input.installed.note } : {}),
  };
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Per-checkout reconcile record
// ---------------------------------------------------------------------------

export interface ResidentServicesStateEntry {
  id: string;
  label: string;
  unit_sha256: string;
  node_path: string;
  installed_at: string;
}

export interface ResidentServicesState {
  instance_id: string;
  repo_root: string;
  reconciled_at: string;
  services: ResidentServicesStateEntry[];
}

export function residentServicesStatePath(): string {
  return shared(RESIDENT_SERVICES_STATE_PATH);
}

export function readResidentServicesState(
  filePath = residentServicesStatePath()
): ResidentServicesState | null {
  try {
    return readJsonIfPresent<ResidentServicesState>(filePath);
  } catch {
    return null;
  }
}

/**
 * Record what reconcile left installed: services it installed now get
 * `installed_at = now`; services already current keep their previous stamp.
 */
export function buildResidentServicesState(input: {
  plan: ResidentServicesPlan;
  desired: Readonly<Record<string, DesiredResidentUnit | undefined>>;
  previous: ResidentServicesState | null;
  /** Service ids whose host change succeeded in this run. */
  changed: ReadonlySet<string>;
  now: Date;
}): ResidentServicesState {
  const previous = new Map(
    (input.previous?.instance_id === input.plan.instanceId ? input.previous.services : []).map(
      (entry) => [entry.id, entry]
    )
  );
  const services: ResidentServicesStateEntry[] = [];
  for (const item of input.plan.items) {
    const desired = input.desired[item.id];
    if (!desired) continue;
    const current = item.action === 'ok' || input.changed.has(item.id);
    if (!current) continue;
    const prior = previous.get(item.id);
    services.push({
      id: item.id,
      label: desired.label,
      unit_sha256: desired.unitSha256,
      node_path: desired.nodePath,
      installed_at:
        input.changed.has(item.id) || !prior || prior.unit_sha256 !== desired.unitSha256
          ? input.now.toISOString()
          : prior.installed_at,
    });
  }
  return {
    instance_id: input.plan.instanceId,
    repo_root: input.plan.repoRoot,
    reconciled_at: input.now.toISOString(),
    services,
  };
}

export function writeResidentServicesState(
  state: ResidentServicesState,
  filePath = residentServicesStatePath()
): void {
  writeJson(filePath, state);
}
