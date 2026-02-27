const { safeWriteFile, safeReadFile } = require('@agent/core/secure-io');
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface InfraAnalysis {
  services: string[];
  databases: string[];
  containerized: boolean;
  orchestrated: boolean;
}

export function detectInfrastructure(dir: string): InfraAnalysis {
  const infra: InfraAnalysis = {
    services: [],
    databases: [],
    containerized: false,
    orchestrated: false,
  };
  const exists = (p: string) => fs.existsSync(path.join(dir, p));

  if (exists('Dockerfile') || exists('docker-compose.yml')) infra.containerized = true;
  if (exists('k8s') || exists('kubernetes')) infra.orchestrated = true;

  if (exists('package.json')) {
    try {
      const pkg = JSON.parse(safeReadFile(path.join(dir, 'package.json'), 'utf8'));
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(' ');
      if (/postgres|mysql|sqlite/i.test(deps)) infra.databases.push('relational');
      if (/mongo/i.test(deps)) infra.databases.push('mongodb');
    } catch {}
  }

  return infra;
}
