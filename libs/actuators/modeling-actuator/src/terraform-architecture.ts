import { terraformToTopologyIr } from './terraform-topology.js';
import { topologyIrToArchitectureAdf } from './topology-to-architecture-adf.js';

export function terraformToArchitectureAdf(exampleRoot: string, options: { title?: string } = {}): any {
  return topologyIrToArchitectureAdf(terraformToTopologyIr(exampleRoot, options));
}
