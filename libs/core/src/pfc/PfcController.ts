import { safeExistsSync, safeReadFile, safeWriteFile } from '../../secure-io.js';

export type Layer = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7';

export interface LayerState {
  status: 'pending' | 'passed' | 'failed';
  attempt_count: number;
}

export interface PfcState {
  layers: Record<Layer, LayerState>;
}

export interface LayerResult {
  passed: boolean;
  circuit_broken: boolean;
}

export class PfcController {
  private stateFilePath: string;
  private state: PfcState;
  private readonly MAX_ATTEMPTS = 3;

  constructor(stateFilePath: string) {
    this.stateFilePath = stateFilePath;
    this.state = this.loadState();
  }

  private getDefaultState(): PfcState {
    return {
      layers: {
        L0: { status: 'pending', attempt_count: 0 },
        L1: { status: 'pending', attempt_count: 0 },
        L2: { status: 'pending', attempt_count: 0 },
        L3: { status: 'pending', attempt_count: 0 },
        L4: { status: 'pending', attempt_count: 0 },
        L5: { status: 'pending', attempt_count: 0 },
        L6: { status: 'pending', attempt_count: 0 },
        L7: { status: 'pending', attempt_count: 0 },
      },
    };
  }

  private loadState(): PfcState {
    if (safeExistsSync(this.stateFilePath)) {
      try {
        const raw = safeReadFile(this.stateFilePath, { encoding: 'utf8' }) as string;
        const parsed = JSON.parse(raw) as PfcState;
        // Forward-compat: a state file persisted before a new layer was
        // added won't have that layer's key. Backfill defaults rather than
        // crash the first time the new layer runs.
        return { layers: { ...this.getDefaultState().layers, ...parsed.layers } };
      } catch (err) {
        return this.getDefaultState();
      }
    }
    return this.getDefaultState();
  }

  private saveState(): void {
    safeWriteFile(this.stateFilePath, JSON.stringify(this.state, null, 2));
  }

  public getState(): PfcState {
    return this.state;
  }

  public async runLayer(layer: Layer, logic: () => Promise<boolean>): Promise<LayerResult> {
    const layerState = this.state.layers[layer];

    if (layerState.status === 'failed' && layerState.attempt_count >= this.MAX_ATTEMPTS) {
      return { passed: false, circuit_broken: true };
    }

    try {
      const passed = await logic();
      if (passed) {
        layerState.status = 'passed';
        layerState.attempt_count = 0;
      } else {
        layerState.attempt_count += 1;
        layerState.status = layerState.attempt_count >= this.MAX_ATTEMPTS ? 'failed' : 'pending';
      }
    } catch (error) {
      layerState.attempt_count += 1;
      layerState.status = layerState.attempt_count >= this.MAX_ATTEMPTS ? 'failed' : 'pending';
    }

    this.saveState();

    return {
      passed: layerState.status === 'passed',
      circuit_broken:
        layerState.status === 'failed' && layerState.attempt_count >= this.MAX_ATTEMPTS,
    };
  }
}
