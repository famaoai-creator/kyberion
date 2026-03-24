import { PfcController, Layer } from './PfcController.js';

export interface LayerDefinition {
  layer: Layer;
  logic: () => Promise<boolean>;
}

export interface SentinelResult {
  success: boolean;
  failedLayer?: Layer;
  circuitBroken: boolean;
}

export class SovereignSentinel {
  private controller: PfcController;
  private registry: Map<Layer, () => Promise<boolean>> = new Map();

  constructor(stateFilePath: string) {
    this.controller = new PfcController(stateFilePath);
  }

  public registerLayer(layer: Layer, logic: () => Promise<boolean>) {
    this.registry.set(layer, logic);
  }

  public async run(): Promise<SentinelResult> {
    // 実行順序 (L0 -> L5)
    const ORDER: Layer[] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];

    for (const layer of ORDER) {
      if (this.registry.has(layer)) {
        const logic = this.registry.get(layer)!;
        const result = await this.controller.runLayer(layer, logic);

        if (!result.passed) {
          return {
            success: false,
            failedLayer: layer,
            circuitBroken: result.circuit_broken
          };
        }
      }
    }

    return {
      success: true,
      circuitBroken: false
    };
  }

  public getState() {
    return this.controller.getState();
  }
}
