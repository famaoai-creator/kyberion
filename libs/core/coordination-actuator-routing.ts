/**
 * Coordination kind → actuator routing (RS-07).
 *
 * `knowledge/product/governance/coordination-actuator-routing.json` is the
 * single source for which actuators a coordination kind (and each execution
 * override such as `capture_photo`) targets. `target_actuators` must name
 * actuators in the actuator manifest catalog; runtime components that are not
 * actuators live in `support_components` so they are never dispatched as one.
 */
import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { loadActuatorManifestCatalog } from './actuator/actuator-manifest-index.js';

export interface CoordinationActuatorRoute {
  target_actuators: string[];
  support_components: string[];
}

export interface CoordinationExecutionOverride extends CoordinationActuatorRoute {
  deliverables: string[];
}

interface CoordinationActuatorRoutingFile {
  version: string;
  default_kind: string;
  coordination_kinds: Record<string, CoordinationActuatorRoute>;
  execution_overrides: Record<string, CoordinationExecutionOverride>;
}

const coordinationRoutingCatalog = defineCatalog<CoordinationActuatorRoutingFile>({
  id: 'coordination-actuator-routing',
  path: () => pathResolver.knowledge('product/governance/coordination-actuator-routing.json'),
  schema: pathResolver.knowledge('product/schemas/coordination-actuator-routing.schema.json'),
});

function loadRouting(): CoordinationActuatorRoutingFile {
  return coordinationRoutingCatalog.load();
}

function copyRoute<T extends CoordinationActuatorRoute>(route: T): T {
  return {
    ...route,
    target_actuators: [...route.target_actuators],
    support_components: [...route.support_components],
  };
}

/** Route for a coordination kind; unregistered kinds use the registry default kind. */
export function resolveCoordinationActuatorRoute(kind: string): CoordinationActuatorRoute {
  const routing = loadRouting();
  const route =
    routing.coordination_kinds[kind] ?? routing.coordination_kinds[routing.default_kind];
  if (!route) {
    throw new Error(
      `[coordination-actuator-routing] no route for coordination kind "${kind}" and default kind "${routing.default_kind}" is not registered`
    );
  }
  return copyRoute(route);
}

/** Execution override route (e.g. `capture_photo`); unknown ids fail closed. */
export function getCoordinationExecutionOverride(id: string): CoordinationExecutionOverride {
  const override = loadRouting().execution_overrides[id];
  if (!override) {
    throw new Error(
      `[coordination-actuator-routing] unknown execution override "${id}" — register it in knowledge/product/governance/coordination-actuator-routing.json`
    );
  }
  return { ...copyRoute(override), deliverables: [...override.deliverables] };
}

/**
 * Validate every `target_actuators` entry against the actuator manifest
 * catalog and ensure no `support_components` entry is an actuator. Returns
 * human-readable violations (empty when valid).
 */
export function validateCoordinationActuatorRouting(
  actuatorIds: readonly string[] = loadActuatorManifestCatalog().map((entry) => entry.n)
): string[] {
  const known = new Set(actuatorIds);
  const routing = loadRouting();
  const violations: string[] = [];
  const check = (label: string, route: CoordinationActuatorRoute) => {
    for (const id of route.target_actuators) {
      if (!known.has(id)) {
        violations.push(
          `${label}: target_actuators entry "${id}" is not in the actuator manifest catalog (move non-actuators to support_components)`
        );
      }
    }
    for (const id of route.support_components) {
      if (known.has(id)) {
        violations.push(
          `${label}: support_components entry "${id}" is an actuator (list it in target_actuators)`
        );
      }
    }
  };
  for (const [kind, route] of Object.entries(routing.coordination_kinds)) {
    check(`coordination_kinds.${kind}`, route);
  }
  for (const [id, route] of Object.entries(routing.execution_overrides)) {
    check(`execution_overrides.${id}`, route);
  }
  if (!routing.coordination_kinds[routing.default_kind]) {
    violations.push(`default_kind "${routing.default_kind}" is not a registered coordination kind`);
  }
  return violations;
}
