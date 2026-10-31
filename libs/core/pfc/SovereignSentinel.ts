import { PfcController, Layer, LayerObservation, LayerRunOptions } from './PfcController.js';

export interface LayerDefinition {
  layer: Layer;
  logic: () => Promise<boolean | LayerObservation>;
}

export interface SentinelResult {
  success: boolean;
  failedLayer?: Layer;
  circuitBroken: boolean;
  deferred?: true;
}

export class SovereignSentinel {
  private controller: PfcController;
  private registry: Map<
    Layer,
    { logic: () => Promise<boolean | LayerObservation>; options: LayerRunOptions }
  > = new Map();

  constructor(stateFilePath: string) {
    this.controller = new PfcController(stateFilePath);
  }

  public registerLayer(
    layer: Layer,
    logic: () => Promise<boolean | LayerObservation>,
    options: LayerRunOptions = {}
  ) {
    this.registry.set(layer, { logic, options });
  }

  public async run(): Promise<SentinelResult> {
    // 実行順序 (L0 -> L9)
    // NOTE: every layer in PfcController's `Layer` union MUST appear here —
    // a registered layer missing from ORDER silently never runs (this
    // exact bug previously left a layer dead; see STATUS ledger).
    const ORDER: Layer[] = [
      'L0',
      'L1',
      'L2',
      'L3',
      'L4',
      'L5',
      'L6',
      'L7',
      'L8',
      'L9',
      'L10',
      'L11',
      'L12',
    ];

    for (const layer of ORDER) {
      if (this.registry.has(layer)) {
        const { logic, options } = this.registry.get(layer)!;
        const result = await this.controller.runLayer(layer, logic, options);

        if (!result.passed) {
          return {
            success: false,
            failedLayer: layer,
            circuitBroken: result.circuit_broken,
            ...(result.deferred ? { deferred: true as const } : {}),
          };
        }
      }
    }

    return {
      success: true,
      circuitBroken: false,
    };
  }

  public getState() {
    return this.controller.getState();
  }
}
