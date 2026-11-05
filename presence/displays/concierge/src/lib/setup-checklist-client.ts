'use client';

import * as React from 'react';
import {
  SETUP_CHECKLIST_ORDER,
  type SetupChecklist,
  type SetupChecklistStep,
} from '@agent/core/surface/setup-checklist-model';
import { frontDeskFetch as fetch } from './front-desk-fetch';

/** The checklist endpoint: surface operation `setup.checklist`. */
export const SETUP_CHECKLIST_PATH = '/api/v1/setup/checklist';

const STATUSES = new Set(['done', 'todo', 'unknown']);
const STEPS = new Set<string>(SETUP_CHECKLIST_ORDER);

/** Validates `{ ok, data: SetupChecklist }`; anything else is `undefined`. */
export function parseSetupChecklistResponse(value: unknown): SetupChecklist | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const envelope = value as { ok?: unknown; data?: unknown };
  if (envelope.ok !== true || !envelope.data || typeof envelope.data !== 'object') return undefined;
  const data = envelope.data as Record<string, unknown>;
  if (!Array.isArray(data.steps)) return undefined;
  const steps: SetupChecklistStep[] = [];
  for (const raw of data.steps) {
    const step = raw as Record<string, unknown> | null;
    if (
      !step ||
      typeof step.id !== 'string' ||
      !STEPS.has(step.id) ||
      typeof step.status !== 'string' ||
      !STATUSES.has(step.status) ||
      typeof step.anchor !== 'string' ||
      !/^[a-z][a-z-]*$/.test(step.anchor) ||
      typeof step.estimate_minutes !== 'number'
    )
      return undefined;
    steps.push(step as unknown as SetupChecklistStep);
  }
  const done = steps.filter((step) => step.status === 'done').length;
  const budget = data.budget as SetupChecklist['budget'] | undefined;
  const validBudget =
    budget &&
    typeof budget === 'object' &&
    typeof budget.daily_cap_usd === 'number' &&
    typeof budget.mission_cap_usd === 'number' &&
    (budget.posture === 'warn' || budget.posture === 'block')
      ? budget
      : undefined;
  const next = steps.find((step) => step.status !== 'done')?.id;
  return {
    steps,
    done,
    total: steps.length,
    complete: steps.length > 0 && done === steps.length,
    ...(next ? { next } : {}),
    ...(validBudget ? { budget: validBudget } : {}),
  };
}

export type SetupChecklistState =
  { phase: 'loading' } | { phase: 'ready'; checklist: SetupChecklist } | { phase: 'unavailable' };

/** Read-only: one GET on mount and on `refresh()`. */
export function useSetupChecklist(): SetupChecklistState & { refresh: () => void } {
  const [state, setState] = React.useState<SetupChecklistState>({ phase: 'loading' });
  const generation = React.useRef(0);
  const refresh = React.useCallback(() => {
    const request = ++generation.current;
    void (async () => {
      try {
        const response = await fetch(SETUP_CHECKLIST_PATH, { cache: 'no-store' });
        const checklist = parseSetupChecklistResponse(await response.json().catch(() => null));
        if (request !== generation.current) return;
        setState(
          response.ok && checklist ? { phase: 'ready', checklist } : { phase: 'unavailable' }
        );
      } catch {
        if (request === generation.current) setState({ phase: 'unavailable' });
      }
    })();
  }, []);
  React.useEffect(() => {
    refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);
  return { ...state, refresh };
}
