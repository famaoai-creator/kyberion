export const RISKY_PATTERNS = [/GPL/i, /AGPL/i, /LGPL/i, /CC-BY-NC/i];

export interface LicenseFinding {
  name: string;
  license: string;
  version?: string;
}

export function scanDepsForRiskyLicenses(deps: any): LicenseFinding[] {
  const findings: LicenseFinding[] = [];
  const scanned = new Set<string>();

  function scan(currentDeps: any) {
    if (!currentDeps) return;
    for (const [name, info] of Object.entries(currentDeps as any)) {
      if (scanned.has(name)) continue;
      scanned.add(name);

      const license =
        (info as any).license ||
        ((info as any).licenses && (info as any).licenses[0]?.type) ||
        'Unknown';
      const isRisky = RISKY_PATTERNS.some((p) => p.test(license));

      if (isRisky) {
        findings.push({ name, license, version: (info as any).version });
      }
      if ((info as any).dependencies) scan((info as any).dependencies);
    }
  }

  scan(deps);
  return findings;
}
