export type OAuthCallbackResult =
  | {
      ok: true;
      serviceId: string;
      result: {
        persisted_path?: string;
        persisted_keys?: string[];
        [key: string]: unknown;
      };
    }
  | {
      ok: false;
      serviceId?: string;
      error: string;
      errorDescription?: string;
    };

/** Persist only callback status metadata; never write provider credentials. */
export function toPersistedOAuthCallbackResult(result: OAuthCallbackResult) {
  if (!result.ok) return result;
  return {
    ok: true as const,
    serviceId: result.serviceId,
    persisted_path: result.result.persisted_path,
    persisted_keys: result.result.persisted_keys,
  };
}
