import type { DeckRequest, EffectResult } from '../actions/effects.js';
import type { DeckSnapshot, MissionDetail, DeckMissionRow } from '../model/types.js';
import type { SupportedLocale } from '@agent/core/locale';

export type HostRequest = DeckRequest | { op: 'missionDetail'; id: string; row?: DeckMissionRow };

export type HostResponseValue = EffectResult | MissionDetail | undefined;

export type ToWorker =
  | { type: 'config'; locale?: SupportedLocale; intervalMs: number; includeAgents: boolean }
  | { type: 'refresh' }
  | { type: 'request'; id: number; request: HostRequest }
  | { type: 'stop' };

export type FromWorker =
  | { type: 'snapshot'; snapshot: DeckSnapshot }
  | { type: 'response'; id: number; ok: true; value: HostResponseValue }
  | { type: 'response'; id: number; ok: false; error: string }
  | { type: 'fatal'; error: string };
