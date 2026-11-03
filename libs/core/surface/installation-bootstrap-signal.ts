/**
 * Dependency-free change signal for the installation bootstrap probe
 * (installation-owner-access.ts caches it briefly). Writers that can close
 * bootstrap — member profile writes, owner-bound token issuance, the
 * first-run claim — bump it so the next request re-probes immediately.
 */
let generation = 0;

export function signalInstallationBootstrapChange(): void {
  generation += 1;
}

export function installationBootstrapGeneration(): number {
  return generation;
}
