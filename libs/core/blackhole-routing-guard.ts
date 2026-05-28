const ACTIVE_ROUTES = new Set<string>();

function normalizeRouteId(routeIdOrPythonBin?: string, defaultMicDevice?: string, rootDir?: string): string {
  return [routeIdOrPythonBin, defaultMicDevice, rootDir].filter(Boolean).join('::') || 'default';
}

export function markRouterActive(routeIdOrPythonBin?: string, defaultMicDevice?: string, rootDir?: string): void {
  ACTIVE_ROUTES.add(normalizeRouteId(routeIdOrPythonBin, defaultMicDevice, rootDir));
}

export function markRouterInactive(routeIdOrPythonBin?: string, defaultMicDevice?: string, rootDir?: string): void {
  ACTIVE_ROUTES.delete(normalizeRouteId(routeIdOrPythonBin, defaultMicDevice, rootDir));
}

export function isRouterActive(routeIdOrPythonBin?: string, defaultMicDevice?: string, rootDir?: string): boolean {
  return ACTIVE_ROUTES.has(normalizeRouteId(routeIdOrPythonBin, defaultMicDevice, rootDir));
}

export function resetRouterSync(): void {
  ACTIVE_ROUTES.clear();
}
