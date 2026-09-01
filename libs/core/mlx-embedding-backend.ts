/* eslint-disable no-restricted-imports -- uses child_process for the Python bridge; IP-08 will move this to a governed exec wrapper */
/**
 * MLX Embedding Backend — Apple Silicon / macOS implementation.
 *
 * Calls scripts/mlx_embed.py via Python subprocess using the mlx-embeddings
 * package from the resolved Kyberion Python runtime. Only available on macOS
 * with Apple Silicon; `isMlxAvailable()` returns false on other platforms.
 *
 * Env vars:
 *   KYBERION_MLX_EMBED_MODEL — HuggingFace model id
 *                              (default: mlx-community/multilingual-e5-large-instruct, 1024d)
 *   KYBERION_PYTHON_BIN      — Python binary override
 *   KYBERION_PYTHON          — Legacy Python override
 */

import { execFileSync } from 'node:child_process';
import { getRegisteredEnvText } from './foundation/env.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { isRecord } from './foundation/text.js';
import { rootResolve } from './path-resolver.js';
import { safeExistsSync } from './secure-io.js';
import { resolveManagedToolPythonBin } from './tool-runtime-registry.js';
import type { EmbeddingBackend } from './embedding-backend.js';

const DEFAULT_MODEL = 'mlx-community/multilingual-e5-large-instruct';
const DEFAULT_DIMS = 1024;

export interface MlxEmbeddingBackendOptions {
  pythonBin?: string;
  model?: string;
  dimensions?: number;
}

export interface MlxEmbeddingResponse {
  vectors?: number[][];
  error?: string;
}

/** Normalize one response emitted by the MLX embedding subprocess. */
export function normalizeMlxEmbeddingResponse(value: unknown): MlxEmbeddingResponse | null {
  if (!isRecord(value)) return null;

  const error = value.error;
  let normalizedError: string | undefined;
  if (error !== undefined) {
    if (typeof error !== 'string') return null;
    normalizedError = error;
  }

  const vectors = value.vectors;
  let normalizedVectors: number[][] | undefined;
  if (vectors !== undefined) {
    if (!Array.isArray(vectors)) return null;
    normalizedVectors = [];
    for (const vector of vectors) {
      if (
        !Array.isArray(vector) ||
        vector.some((component) => typeof component !== 'number' || !Number.isFinite(component))
      ) {
        return null;
      }
      normalizedVectors.push(vector);
    }
  }

  if (normalizedError === undefined && normalizedVectors === undefined) return null;
  return {
    ...(normalizedVectors !== undefined ? { vectors: normalizedVectors } : {}),
    ...(normalizedError !== undefined ? { error: normalizedError } : {}),
  };
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

    const candidate =
      options.pythonBin ??
      getRegisteredEnvText('KYBERION_PYTHON_BIN') ??
      getRegisteredEnvText('KYBERION_PYTHON') ??
      resolveManagedToolPythonBin('mlx_audio') ??
      resolveManagedToolPythonBin('mlx_whisper') ??
      rootResolve('.venv/bin/python3');
    this.pythonBin = safeExistsSync(candidate) ? candidate : 'python3';
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
        const parsed = normalizeMlxEmbeddingResponse(
          parseSafeJsonInput(line, 'MLX embedding response')
        );
        if (!parsed) continue;
        if (parsed.error !== undefined) throw new Error(`[mlx-embedding] ${parsed.error}`);
        if (parsed.vectors !== undefined) {
          return parsed.vectors.map((vector) => new Float32Array(vector));
        }
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
  return safeExistsSync(rootResolve('scripts/mlx_embed.py'));
}

/** Log which Python binary and model will be used (for diagnostics). */
export function probeMlxEmbeddingBackend(env: NodeJS.ProcessEnv = process.env): {
  available: boolean;
  model: string;
  scriptPath: string;
} {
  const scriptPath = rootResolve('scripts/mlx_embed.py');
  return {
    available: process.platform === 'darwin' && safeExistsSync(scriptPath),
    model: env.KYBERION_MLX_EMBED_MODEL ?? DEFAULT_MODEL,
    scriptPath,
  };
}
