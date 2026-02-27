import * as fs from 'node:fs';
import * as path from 'node:path';

export interface EnergyUsage {
  totalKwh: number;
  co2Kg: number;
  efficiency_score: number;
  recommendations: string[];
}

// Heuristic carbon intensity factors (Average kgCO2e per kWh)
const CARBON_INTENSITY = {
  DEFAULT: 0.475,
  US_EAST_1: 0.367, // Example: Virginia
  EU_WEST_1: 0.288, // Example: Ireland (Cleaner)
  AP_NORTHEAST_1: 0.463, // Example: Tokyo
};

export function assessInfraEnergy(dir: string): EnergyUsage {
  let totalKwh = 0;
  let score = 100;
  const recommendations: string[] = [];
  const exists = (p: string) => fs.existsSync(path.join(dir, p));

  const content = (p: string) => exists(p) ? fs.readFileSync(path.join(dir, p), 'utf8') : '';

  // 1. Compute Infrastructure Footprint
  if (exists('docker-compose.yml')) totalKwh += 50;
  if (exists('k8s') || exists('kubernetes')) totalKwh += 200;
  
  const tfContent = content('main.tf');
  if (tfContent.includes('t3.medium') || tfContent.includes('t2.')) {
    recommendations.push('Consider migrating to Graviton (m6g/t4g) for 40% better price-performance and lower energy.');
    score -= 10;
  }

  if (!tfContent.includes('lambda') && !tfContent.includes('fargate')) {
    recommendations.push('Leverage Serverless (Lambda/Fargate) to reduce idle resource consumption.');
    score -= 15;
  }

  // 2. Region Awareness
  let intensity = CARBON_INTENSITY.DEFAULT;
  if (tfContent.includes('ap-northeast-1')) intensity = CARBON_INTENSITY.AP_NORTHEAST_1;
  if (tfContent.includes('eu-west-1')) intensity = CARBON_INTENSITY.EU_WEST_1;

  return {
    totalKwh,
    co2Kg: Math.round(totalKwh * intensity * 10) / 10,
    efficiency_score: score,
    recommendations
  };
}
