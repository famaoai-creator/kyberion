export const SUSPICIOUS_PATTERNS = [
  { pattern: /postinstall.*curl|wget|fetch/i, risk: 'Network call in postinstall' },
  { pattern: /eval\s*\(\s*(?:Buffer|atob|decode)/i, risk: 'Obfuscated code execution' },
];

export function scanForSuspicious(content: string, fileName: string): any[] {
  const findings: any[] = [];
  for (const rule of SUSPICIOUS_PATTERNS) {
    if (rule.pattern.test(content)) {
      findings.push({ file: fileName, risk: rule.risk });
    }
  }
  return findings;
}

export function parsePackageJson(content: string): any[] {
  const components: any[] = [];
  try {
    const pkg = JSON.parse(content);
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const [name, version] of Object.entries(allDeps)) {
      components.push({
        name,
        version: (version as string).replace(/[\^~>=<]/g, ''),
        ecosystem: 'npm',
      });
    }
  } catch {}
  return components;
}
