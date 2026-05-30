/**
 * MLX Embedding Backend — Apple Silicon / macOS implementation.
 *
 * Calls scripts/mlx_embed.py via Python subprocess using the mlx-embeddings
 * package (pip install mlx-embeddings). Only available on macOS with Apple
 * Silicon; `isMlxAvailable()` returns false on other platforms.
 *
 * Env vars:
 *   KYBERION_MLX_EMBED_MODEL — HuggingFace model id
 *                              (default: mlx-community/multilingual-e5-large-instruct, 1024d)
 *   KYBERION_PYTHON_BIN      — Python binary override (default: .venv/bin/python3 → python3)
 */

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { logger } from './core.js';
import { rootResolve } from './path-resolver.js';
import type { EmbeddingBackend } from './embedding-backend.js';

const DEFAULT_MODEL = 'mlx-community/multilingual-e5-large-instruct';
const DEFAULT_DIMS = 1024;

export interface MlxEmbeddingBackendOptions {
  pythonBin?: string;
  model?: string;
  dimensions?: number;
}

export class MlxEmbeddingBackend implements EmbeddingBackend {
  readonly name = 'mlx';
  readonly dimensions: number;

  private readonly pythonBin: string;
  private readonly scriptPath: string;
  private readonly model: string;

  constructor(options: MlxEmbeddingBackendOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.dimensions = options.dimensions ?? DEFAULT_DIMS;
    this.scriptPath = rootResolve('scripts/mlx_embed.py');

    const candidate = options.pythonBin ?? rootResolve('.venv/bin/python3');
    this.pythonBin = fs.existsSync(candidate) ? candidate : 'python3';
  }

  async embed(text: string): Promise<Float32Array> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const payload = JSON.stringify({ model: this.model, texts });
    let stdout: string;
    try {
      stdout = execFileSync(this.pythonBin, [this.scriptPath, payload], {
        encoding: 'utf8',
        timeout: 120_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw new Error(`[mlx-embedding] subprocess failed: ${err}`);
    }

    for (const line of stdout.trim().split('\n').reverse()) {
      try {
        const parsed = JSON.parse(line) as { vectors?: number[][]; error?: string };
        if (parsed.error) throw new Error(`[mlx-embedding] ${parsed.error}`);
        if (parsed.vectors) return parsed.vectors.map(v => new Float32Array(v));
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
    throw new Error('[mlx-embedding] no vectors in subprocess output');
  }
}

/** Returns true when macOS + mlx_embed.py script is present. */
export function isMlxAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  return fs.existsSync(rootResolve('scripts/mlx_embed.py'));
}

/** Log which Python binary and model will be used (for diagnostics). */
export function probeMlxEmbeddingBackend(env: NodeJS.ProcessEnv = process.env): {
  available: boolean;
  model: string;
  scriptPath: string;
} {
  const scriptPath = rootResolve('scripts/mlx_embed.py');
  return {
    available: process.platform === 'darwin' && fs.existsSync(scriptPath),
    model: env.KYBERION_MLX_EMBED_MODEL ?? DEFAULT_MODEL,
    scriptPath,
  };
}
