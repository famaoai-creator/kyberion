import { terraformToTopologyIr } from './terraform-topology.js';
import { topologyIrToArchitectureAdf } from './topology-to-architecture-adf.js';
import type { KyberionArchitectureDescriptionFormatADF } from '@agent/core/contracts/architecture-adf';

export function terraformToArchitectureAdf(
  exampleRoot: string,
  options: { title?: string } = {}
): KyberionArchitectureDescriptionFormatADF {
  return topologyIrToArchitectureAdf(terraformToTopologyIr(exampleRoot, options));
}
