import { metrics } from './metrics.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { getUsageAttribution, type UsageBillingMode, type UsageCause } from './usage-accounting.js';

export interface CliTokenUsage {
  /** Uncached input only. Cache counters below are disjoint. */
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cache_write_1h_tokens?: number;
}

export interface CliUsageEntry {
  model?: string;
  usage: CliTokenUsage;
  /** API-list equivalent reported by a CLI, not evidence of an invoice charge. */
  referenceCostUsd?: number;
}

export interface CliUsageReport {
  entries: CliUsageEntry[];
  referenceCostUsd?: number;
  isError?: boolean;
}

/** The final flag wins, matching CLI argv precedence (including --flag=value). */
export function cliOutputFormat(args: readonly string[]): string | undefined {
  let format: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--output-format' || arg === '-o') {
      format = args[index + 1];
      index += 1;
    } else if (arg.startsWith('--output-format=')) format = arg.slice('--output-format='.length);
  }
  return format;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function amount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Parse transport JSON/JSONL, never JSON nested in a model-authored text field. */
function transportRecords(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parse = (text: string): unknown => {
    try {
      return parseSafeJsonInput(text, 'CLI usage transport');
    } catch {
      return undefined;
    }
  };
  const whole = parse(trimmed);
  if (object(whole)) return [whole as Record<string, unknown>];
  if (Array.isArray(whole))
    return whole.map(object).filter((item): item is Record<string, unknown> => Boolean(item));
  const lines = trimmed.split('\n');
  // Gemini can precede its pretty-printed envelope with a startup notice.
  const firstJson = lines.findIndex((line) => line.trim().startsWith('{'));
  if (firstJson >= 0) {
    const envelope = object(parse(lines.slice(firstJson).join('\n')));
    if (envelope) return [envelope];
  }
  return lines
    .map((line) => object(parse(line)))
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function anthropicUsage(raw: unknown, camelCase = false): CliTokenUsage | undefined {
  const data = object(raw);
  if (!data) return undefined;
  const prompt = count(data[camelCase ? 'inputTokens' : 'input_tokens']);
  const completion = count(data[camelCase ? 'outputTokens' : 'output_tokens']);
  if (prompt === undefined || completion === undefined) return undefined;
  const read = count(data[camelCase ? 'cacheReadInputTokens' : 'cache_read_input_tokens']);
  const write = count(data[camelCase ? 'cacheCreationInputTokens' : 'cache_creation_input_tokens']);
  if (
    (data[camelCase ? 'cacheReadInputTokens' : 'cache_read_input_tokens'] !== undefined &&
      read === undefined) ||
    (data[camelCase ? 'cacheCreationInputTokens' : 'cache_creation_input_tokens'] !== undefined &&
      write === undefined)
  )
    return undefined;
  const creation = object(data.cache_creation);
  if (!camelCase && data.cache_creation !== undefined && !creation) return undefined;
  const write1h = camelCase ? undefined : count(creation?.ephemeral_1h_input_tokens);
  if (!camelCase && creation?.ephemeral_1h_input_tokens !== undefined && write1h === undefined)
    return undefined;
  if (write1h !== undefined && (write === undefined || write1h > write)) return undefined;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    ...(read !== undefined ? { cache_read_tokens: read } : {}),
    ...(write !== undefined ? { cache_write_tokens: write - (write1h ?? 0) } : {}),
    ...(write1h !== undefined ? { cache_write_1h_tokens: write1h } : {}),
  };
}

/** Claude's terminal result supersedes assistant snapshots and model breakdowns. */
export function parseClaudeCliUsage(stdout: string): CliUsageReport | undefined {
  const records = transportRecords(stdout);
  const terminal = records.filter((record) => record.type === 'result').at(-1);
  if (terminal) {
    const reference = amount(terminal.total_cost_usd);
    const usage = anthropicUsage(terminal.usage);
    if (usage)
      return {
        entries: [{ usage, referenceCostUsd: reference }],
        isError: terminal.is_error === true,
      };
    const models = object(terminal.modelUsage);
    const entries: CliUsageEntry[] = [];
    for (const [model, value] of Object.entries(models ?? {})) {
      const modelUsage = anthropicUsage(value, true);
      if (modelUsage)
        entries.push({
          model,
          usage: modelUsage,
          referenceCostUsd: amount(object(value)?.costUSD),
        });
    }
    if (entries.length) return { entries, isError: terminal.is_error === true };
    if (reference !== undefined)
      return { entries: [], referenceCostUsd: reference, isError: terminal.is_error === true };
  }
  // Interrupted streams may have no result. Distinct completed assistant
  // message ids are safe to count; repeated snapshots of one id replace it.
  const messages = new Map<string, CliUsageEntry>();
  for (const record of records) {
    if (record.type !== 'assistant') continue;
    const message = object(record.message);
    const usage = anthropicUsage(message?.usage);
    if (typeof message?.id !== 'string' || !message.id || !usage) continue;
    messages.set(message.id, {
      usage,
      ...(typeof message.model === 'string' ? { model: message.model } : {}),
    });
  }
  return messages.size
    ? { entries: [...messages.values()], isError: terminal?.is_error === true }
    : terminal?.is_error === true
      ? { entries: [], isError: true }
      : undefined;
}

/** `codex exec --json` has one final turn usage snapshot, not a bill per event. */
export function parseCodexCliUsage(stdout: string): CliUsageReport | undefined {
  const terminal = transportRecords(stdout)
    .filter((record) => record.type === 'turn.completed')
    .at(-1);
  const usage = object(terminal?.usage);
  const input = count(usage?.input_tokens);
  const output = count(usage?.output_tokens);
  const cached = usage?.cached_input_tokens === undefined ? 0 : count(usage.cached_input_tokens);
  if (input === undefined || output === undefined || cached === undefined || cached > input)
    return undefined;
  return {
    entries: [
      {
        usage: {
          // Codex cache writes have ordinary input pricing, so they stay in
          // the prompt bucket rather than becoming an unpriced extra bucket.
          prompt_tokens: input - cached,
          completion_tokens: output,
          cache_read_tokens: cached,
        },
      },
    ],
  };
}

/** Gemini session model totals already include role/API-call subtotals. */
export function parseGeminiCliUsage(stdout: string): CliUsageReport | undefined {
  const terminal = transportRecords(stdout)
    .filter((record) => typeof record.response === 'string' || object(record.error))
    .at(-1);
  const models = object(object(terminal?.stats)?.models);
  if (!models) return terminal?.error ? { entries: [], isError: true } : undefined;
  const entries: CliUsageEntry[] = [];
  for (const [model, data] of Object.entries(models)) {
    const tokens = object(object(data)?.tokens);
    const cached = tokens?.cached === undefined ? 0 : count(tokens.cached);
    // upstream uiTelemetry: input = prompt - cached; prompt includes cache.
    const prompt = count(tokens?.prompt);
    const input = count(tokens?.input);
    const candidates = count(tokens?.candidates);
    const thoughts = tokens?.thoughts === undefined ? 0 : count(tokens.thoughts);
    if (
      candidates === undefined ||
      cached === undefined ||
      thoughts === undefined ||
      (prompt === undefined && input === undefined) ||
      (prompt !== undefined && cached > prompt)
    )
      continue;
    const completion = candidates + thoughts;
    if (!Number.isSafeInteger(completion)) continue;
    entries.push({
      model,
      usage: {
        prompt_tokens: prompt !== undefined ? prompt - cached : input!,
        completion_tokens: completion,
        cache_read_tokens: cached,
      },
    });
  }
  return entries.length
    ? { entries, isError: Boolean(terminal?.error) }
    : terminal?.error
      ? { entries: [], isError: true }
      : undefined;
}

export interface RecordCliUsageOptions {
  report?: CliUsageReport;
  promptChars: number;
  completionChars: number;
  /** Explicit trusted configuration only; never inferred from a CLI binary. */
  billingMode?: UsageBillingMode;
  /** A failed spawn/aborted-before-spawn cannot have consumed inference. */
  requestNotSent?: boolean;
  /** SDK paths with no transport usage do not have a trustworthy text estimate. */
  allowCharacterEstimate?: boolean;
  cause?: UsageCause;
  agent?: string;
}

/** One metric per provider model total; character fallback only on success. */
export function recordCliUsage(
  component: string,
  model: string,
  started: number,
  status: 'success' | 'error',
  options: RecordCliUsageOptions
): void {
  // A diagnostic for an invocation that never started is not uncertain LLM
  // spend: no provider request occurred. Its caller already reports the error.
  if (options.requestNotSent) return;
  try {
    const attribution = getUsageAttribution();
    const effectiveStatus = options.report?.isError ? 'error' : status;
    const providerEntries = options.requestNotSent ? [] : (options.report?.entries ?? []);
    const characterEstimate =
      !providerEntries.length &&
      effectiveStatus === 'success' &&
      !options.requestNotSent &&
      options.allowCharacterEstimate !== false;
    const entries: Array<Partial<CliUsageEntry>> = providerEntries.length
      ? providerEntries
      : [
          {
            ...(characterEstimate
              ? {
                  usage: {
                    prompt_tokens: Math.ceil(Math.max(0, options.promptChars) / 4),
                    completion_tokens: Math.ceil(Math.max(0, options.completionChars) / 4),
                  },
                }
              : {}),
            referenceCostUsd: options.report?.referenceCostUsd,
          },
        ];
    for (const entry of entries) {
      metrics.record(component, Date.now() - started, effectiveStatus, {
        model: entry.model || model,
        agent: options.agent ?? component,
        ...(options.cause ? { cause: options.cause } : {}),
        ...(attribution
          ? {
              scope: attribution.scope,
              actor_id: attribution.actor_id,
              ...(attribution.accounting_id ? { accounting_id: attribution.accounting_id } : {}),
            }
          : {}),
        mission_id: getRegisteredEnvText('MISSION_ID') || undefined,
        estimated: characterEstimate,
        billing_mode: options.billingMode ?? 'unknown',
        usage_source: providerEntries.length
          ? 'provider'
          : characterEstimate
            ? 'character_estimate'
            : 'unknown',
        ...(entry.usage ? { usage: entry.usage } : { cost_status: 'unknown', cost_source: 'none' }),
        ...(entry.referenceCostUsd !== undefined
          ? { reference_cost_usd: entry.referenceCostUsd, cost_source: 'provider_report' }
          : {}),
      });
    }
  } catch {
    /* metering must never break reasoning */
  }
}

/** Compatibility fallback for CLIs whose transport does not expose usage. */
export function recordEstimatedCliUsage(
  component: string,
  model: string,
  started: number,
  status: 'success' | 'error',
  promptChars: number,
  completionChars: number
): void {
  recordCliUsage(component, model, started, status, { promptChars, completionChars });
}
