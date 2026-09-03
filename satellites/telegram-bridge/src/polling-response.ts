import { parseSafeJsonObjectValue } from '@agent/core/foundation';

export interface TelegramPollingUpdate {
  update_id: number;
  [key: string]: unknown;
}

export interface TelegramPollingResponse {
  ok?: boolean;
  result?: unknown;
}

export function parsePollingResponse(value: unknown): TelegramPollingResponse {
  try {
    const record = parseSafeJsonObjectValue(value, 'Telegram polling response');
    return {
      ok: typeof record.ok === 'boolean' ? record.ok : undefined,
      result: record.result,
    };
  } catch {
    return {};
  }
}

export function parsePollingUpdates(value: unknown): TelegramPollingUpdate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    try {
      const record = parseSafeJsonObjectValue(item, `Telegram polling update[${index}]`);
      return Number.isSafeInteger(record.update_id)
        ? [{ ...record, update_id: record.update_id } as TelegramPollingUpdate]
        : [];
    } catch {
      return [];
    }
  });
}
