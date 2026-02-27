import * as fs from 'node:fs';
import * as path from 'node:path';

export interface EnergyUsage {
  totalKwh: number;
  co2Kg: number;
}

export function assessInfraEnergy(dir: string): EnergyUsage {
  let totalKwh = 0;
  const exists = (p: string) => fs.existsSync(path.join(dir, p));

  if (exists('docker-compose.yml')) totalKwh += 50;
  if (exists('k8s') || exists('kubernetes')) totalKwh += 200;

  return {
    totalKwh,
    co2Kg: Math.round(totalKwh * 0.4 * 10) / 10,
  };
}
