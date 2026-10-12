'use client';

import {
  selectionEndpoint,
  SelectionResponseError,
  type SelectionSnapshot,
  type SelectionTransport,
} from './selection-contract';

/** Browser-only transport: fixed same-origin paths, no redirects, no credential forwarding. */
export const requestSelection: SelectionTransport = async (target, command, signal) => {
  const response = await fetch(selectionEndpoint(target), {
    method: command ? 'POST' : 'GET',
    credentials: 'same-origin',
    mode: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    headers: command ? { 'content-type': 'application/json' } : undefined,
    body: command ? JSON.stringify(command) : undefined,
    signal,
  });
  if (!response.ok) {
    // Server errors never include raw registry/configuration or filesystem details.
    throw new SelectionResponseError(
      response.status,
      response.status === 409 ? 'STALE_SELECTION' : 'SELECTION_REQUEST_FAILED'
    );
  }
  return (await response.json()) as SelectionSnapshot;
};
