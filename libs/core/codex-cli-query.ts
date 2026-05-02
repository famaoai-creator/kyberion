import { spawn } from 'node:child_process';
import path from 'node:path';
import { z, type ZodType } from 'zod';
import { logger } from './core.js';
import * as pathResolver from './path-resolver.js';
import { buildSafeExecEnv, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

export interface CodexCliQueryOptions {
  bin?: string;
  model?: string;
  timeoutMs?: number;
  extraArgs?: string[];
  cwd?: string;
}

export interface RunCodexCliQueryParams<T> {
  systemPrompt: string;
  userPrompt: string;
  schema: ZodType<T>;
  mode?: 'read-only' | 'workspace-write';
  options?: CodexCliQueryOptions;
}

export async function runCodexCliQuery<T>({
  systemPrompt,
  userPrompt,
  schema,
  mode = 'read-only',
  options = {},
}: RunCodexCliQueryParams<T>): Promise<T> {
  const query = new CodexCliQuery(options);
  return query.runStructured({ systemPrompt, userPrompt, schema, mode });
}

class CodexCliQuery {
  private readonly bin: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly extraArgs: string[];
  private readonly cwd: string;

  constructor(options: CodexCliQueryOptions = {}) {
    this.bin = options.bin ?? 'codex';
    this.model = options.model ?? 'gpt-5.4';
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    this.extraArgs = options.extraArgs ?? [];
    this.cwd = options.cwd ?? pathResolver.rootDir();
  }

  async runStructured<T>(params: {
    systemPrompt: string;
    userPrompt: string;
    schema: ZodType<T>;
    mode: 'read-only' | 'workspace-write';
  }): Promise<T> {
    const schemaJson = normalizeCodexSchema(
      z.toJSONSchema(params.schema) as Record<string, unknown>,
    );
    const schemaPath = this.tempFilePath('codex-schema', 'json');
    const outputPath = this.tempFilePath('codex-output', 'json');
    safeWriteFile(schemaPath, JSON.stringify(schemaJson, null, 2), { mkdir: true });

    try {
      const prompt = [
        params.systemPrompt.trim(),
        '',
        params.userPrompt.trim(),
        '',
        'Return exactly one JSON object that matches the provided output schema.',
        'Do not wrap the JSON in markdown fences.',
      ].join('\n');

      const args = [
        'exec',
        '--sandbox',
        params.mode,
        '--model',
        this.model,
        '--output-schema',
        schemaPath,
        '--output-last-message',
        outputPath,
        '--color',
        'never',
        '-C',
        this.cwd,
        ...this.extraArgs,
        '-',
      ];

      await this.spawnCli(args, prompt);

      const raw = safeReadFile(outputPath, { encoding: 'utf8' }) as string;
      const clean = extractJsonPayload(raw);
      const parsedJson = JSON.parse(clean);
      const parsed = params.schema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new Error(`[codex-cli] schema validation failed: ${parsed.error.message}`);
      }
      return parsed.data;
    } catch (err: any) {
      throw new Error(`[codex-cli] structured query failed: ${err?.message ?? String(err)}`);
    } finally {
      safeRmSync(schemaPath, { force: true });
      safeRmSync(outputPath, { force: true });
    }
  }

  private spawnCli(args: string[], stdin: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildSafeExecEnv(),
        cwd: this.cwd,
      });
      let stderr = '';
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`[codex-cli] timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new Error(
              `[codex-cli] CLI exited with code ${code}. stderr: ${stderr.slice(0, 1000)} stdout: ${stdout.slice(0, 500)}`,
            ),
          );
          return;
        }
        resolve();
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`[codex-cli] spawn failed: ${err.message}`));
      });
      child.stdin.write(stdin);
      child.stdin.end();
    });
  }

  private tempFilePath(prefix: string, extension: string): string {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return path.join(pathResolver.sharedTmp(), `kyberion-${prefix}-${id}.${extension}`);
  }
}

function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/u) || trimmed.match(/```\s*([\s\S]*?)```/u);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return trimmed;
}

function normalizeCodexSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(schema);
  normalizeSchemaNode(clone);
  return clone;
}

function normalizeSchemaNode(node: unknown): void {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) normalizeSchemaNode(item);
    return;
  }

  const record = node as Record<string, unknown>;

  if (record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)) {
    const properties = record.properties as Record<string, unknown>;
    const originalRequired = Array.isArray(record.required)
      ? new Set((record.required as unknown[]).filter((value): value is string => typeof value === 'string'))
      : new Set<string>();
    for (const [key, value] of Object.entries(properties)) {
      normalizeSchemaNode(value);
      properties[key] = originalRequired.has(key) ? value : ensureNullable(value);
    }
    record.required = Object.keys(properties);
  }

  if (record.items) normalizeSchemaNode(record.items);
  if (Array.isArray(record.anyOf)) record.anyOf.forEach(normalizeSchemaNode);
  if (Array.isArray(record.oneOf)) record.oneOf.forEach(normalizeSchemaNode);
  if (Array.isArray(record.allOf)) record.allOf.forEach(normalizeSchemaNode);
}

function ensureNullable(node: unknown): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const record = node as Record<string, unknown>;

  if (record.anyOf && Array.isArray(record.anyOf)) {
    if (!record.anyOf.some((entry) => isNullSchema(entry))) {
      record.anyOf = [...record.anyOf, { type: 'null' }];
    }
    return record;
  }

  if (record.oneOf && Array.isArray(record.oneOf)) {
    if (!record.oneOf.some((entry) => isNullSchema(entry))) {
      record.oneOf = [...record.oneOf, { type: 'null' }];
    }
    return record;
  }

  const typeValue = record.type;
  if (typeof typeValue === 'string') {
    if (typeValue !== 'null') {
      record.type = [typeValue, 'null'];
    }
    return record;
  }

  if (Array.isArray(typeValue)) {
    if (!typeValue.includes('null')) {
      record.type = [...typeValue, 'null'];
    }
  }

  return record;
}

function isNullSchema(node: unknown): boolean {
  return Boolean(node && typeof node === 'object' && !Array.isArray(node) && (node as Record<string, unknown>).type === 'null');
}

export function buildCodexCliQueryOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CodexCliQueryOptions {
  const bin = env.KYBERION_CODEX_CLI_BIN?.trim();
  const model = env.KYBERION_CODEX_CLI_MODEL?.trim();
  const timeoutRaw = env.KYBERION_CODEX_CLI_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;
  const extraRaw = env.KYBERION_CODEX_CLI_EXTRA_ARGS?.trim();
  const extraArgs = extraRaw ? extraRaw.split(/\s+/u).filter(Boolean) : undefined;

  logger.info(
    `[codex-cli] query helper ready (bin=${bin ?? 'codex'}, model=${model ?? 'gpt-5.4'})`,
  );

  return {
    ...(bin ? { bin } : {}),
    ...(model ? { model } : {}),
    ...(timeoutMs && !isNaN(timeoutMs) ? { timeoutMs } : {}),
    ...(extraArgs ? { extraArgs } : {}),
  };
}
