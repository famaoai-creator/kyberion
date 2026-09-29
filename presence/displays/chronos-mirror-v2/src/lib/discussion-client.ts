'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  DiscussionCommand,
  DiscussionRoomState,
  DiscussionRoomSummary,
} from '@agent/core/discussion/discussion-types';

export type { DiscussionCommand, DiscussionRoomState, DiscussionRoomSummary };

export type DiscussionLocale = 'ja' | 'en';

export const ROLE_LABELS: Record<string, { ja: string; en: string }> = {
  facilitator: { ja: 'ファシリテーター', en: 'Facilitator' },
  researcher: { ja: 'リサーチャー', en: 'Researcher' },
  devils_advocate: { ja: '悪魔の代弁者', en: "Devil's Advocate" },
  scribe: { ja: '書記', en: 'Scribe' },
  planner: { ja: 'プランナー', en: 'Planner' },
  implementer: { ja: '実装担当', en: 'Implementer' },
  reviewer: { ja: 'レビュアー', en: 'Reviewer' },
  product_strategist: { ja: 'プロダクト戦略', en: 'Product Strategist' },
  experience_designer: { ja: 'UXデザイナー', en: 'Experience Designer' },
  tester: { ja: 'テスター', en: 'Tester' },
};

export function roleLabel(role: string, locale: DiscussionLocale): string {
  return ROLE_LABELS[role]?.[locale] ?? role;
}

const STRINGS = {
  title: { ja: 'ディスカッションルーム', en: 'Discussion Room' },
  subtitle: {
    ja: '目的に向けて、組織のエージェントがファシリテーターのもとで議論します',
    en: 'Organization agents deliberate toward a goal under a facilitator',
  },
  goalLabel: { ja: '達成したい目的', en: 'Goal to achieve' },
  goalPlaceholder: {
    ja: '例: 新しい請求システムを段階的に導入すべきか判断する',
    en: 'e.g. Decide whether to roll out the new billing system in stages',
  },
  start: { ja: 'チームを組成して開始', en: 'Form a team and start' },
  starting: { ja: '組成中…', en: 'Forming…' },
  tempo: { ja: '進行速度', en: 'Tempo' },
  tempoFast: { ja: '速い', en: 'Fast' },
  tempoNormal: { ja: '標準', en: 'Normal' },
  tempoSlow: { ja: 'ゆっくり', en: 'Slow' },
  engine: { ja: '発言エンジン', en: 'Speaker engine' },
  engineAuto: { ja: '自動（利用可能ならLLM）', en: 'Auto (LLM if available)' },
  engineScripted: { ja: 'デモ台本（オフライン）', en: 'Scripted demo (offline)' },
  engineReasoning: { ja: 'LLM推論', en: 'LLM reasoning' },
  examples: { ja: '例から始める', en: 'Start from an example' },
  recent: { ja: '過去のルーム', en: 'Recent rooms' },
  noRooms: { ja: 'まだルームがありません', en: 'No rooms yet' },
  newRoom: { ja: '新しいルーム', en: 'New room' },
  team: { ja: 'チーム', en: 'Team' },
  agenda: { ja: '議題', en: 'Agenda' },
  conversation: { ja: '会話', en: 'Conversation' },
  situation: { ja: '現在の状況', en: 'Situation' },
  command: { ja: 'コマンドセンター', en: 'Command Center' },
  consensus: { ja: '合意度', en: 'Consensus' },
  consensusTrend: { ja: '合意度の推移', en: 'Consensus by round' },
  stanceMap: { ja: '立場マップ', en: 'Stance map' },
  openIssues: { ja: '未解消の論点', en: 'Open issues' },
  agreements: { ja: '合意事項', en: 'Agreements' },
  decision: { ja: '決定', en: 'Decision' },
  dissent: { ja: '残った反対意見', en: 'Recorded dissent' },
  nextSteps: { ja: '次のアクション', en: 'Next steps' },
  votes: { ja: '投票', en: 'Vote' },
  thinking: { ja: '発言を準備中', en: 'is composing' },
  round: { ja: 'ラウンド', en: 'Round' },
  roundSummary: { ja: 'ファシリテーターの総括', en: 'Facilitator summary' },
  you: { ja: 'あなた（人間）', en: 'You (human)' },
  everyone: { ja: '全員', en: 'Everyone' },
  pause: { ja: '一時停止', en: 'Pause' },
  resume: { ja: '再開', en: 'Resume' },
  conclude: { ja: '結論に進む', en: 'Conclude now' },
  stop: { ja: '中止', en: 'Stop' },
  modeInject: { ja: '発言する', en: 'Say' },
  modeAsk: { ja: '指名して質問', en: 'Ask' },
  modeRedirect: { ja: '議題を変える', en: 'Redirect' },
  modeVote: { ja: '投票を開く', en: 'Call a vote' },
  send: { ja: '送信', en: 'Send' },
  messagePlaceholderInject: {
    ja: '議論に割り込んで意見や条件を伝える',
    en: 'Interject with an opinion or constraint',
  },
  messagePlaceholderAsk: { ja: '選んだエージェントに質問する', en: 'Ask the selected agent' },
  messagePlaceholderRedirect: {
    ja: '新しい論点を議題の先頭に置く',
    en: 'Put a new topic at the top of the agenda',
  },
  messagePlaceholderVote: { ja: '投票にかける問い', en: 'Question to put to a vote' },
  target: { ja: '宛先', en: 'To' },
  castVote: { ja: 'あなたの1票', en: 'Cast your vote' },
  speakNext: { ja: '次に発言させる', en: 'Speak next' },
  readOnly: {
    ja: '閲覧のみ: 操作には localadmin 権限が必要です',
    en: 'View only: steering requires localadmin access',
  },
  connecting: { ja: '接続中…', en: 'Connecting…' },
  live: { ja: 'ライブ', en: 'Live' },
  ended: { ja: '終了', en: 'Ended' },
  stancesSupport: { ja: '賛成', en: 'Support' },
  stancesOppose: { ja: '反対', en: 'Oppose' },
  stancesNeutral: { ja: '中立', en: 'Neutral' },
  stancesQuestion: { ja: '要確認', en: 'Question' },
  engineMode: { ja: 'エンジン', en: 'Engine' },
  fit: { ja: '適合度', en: 'Fit' },
  gaps: { ja: '配置できなかった役割', en: 'Unstaffed roles' },
  back: { ja: 'ルーム一覧へ', en: 'All rooms' },
  errorTitle: { ja: 'エラー', en: 'Error' },
  scope: { ja: 'スコープ', en: 'Scope' },
} satisfies Record<string, { ja: string; en: string }>;

export type DiscussionStringKey = keyof typeof STRINGS;

export function dt(key: DiscussionStringKey, locale: DiscussionLocale): string {
  return STRINGS[key][locale];
}

export const STATUS_LABELS: Record<string, { ja: string; en: string }> = {
  forming: { ja: 'チーム組成中', en: 'Forming team' },
  running: { ja: '議論中', en: 'In discussion' },
  paused: { ja: '一時停止中', en: 'Paused' },
  awaiting_human: { ja: '人間の判断待ち', en: 'Awaiting human' },
  concluded: { ja: '結論に到達', en: 'Concluded' },
  stopped: { ja: '中止', en: 'Stopped' },
  failed: { ja: '失敗', en: 'Failed' },
};

export const PHASE_STEPS: Array<{ id: string; ja: string; en: string }> = [
  { id: 'forming', ja: '組成', en: 'Form' },
  { id: 'framing', ja: '論点設定', en: 'Frame' },
  { id: 'exploring', ja: '検討', en: 'Explore' },
  { id: 'converging', ja: '収束', en: 'Converge' },
  { id: 'concluded', ja: '決定', en: 'Decide' },
];

export interface DiscussionApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

async function call<T>(url: string, init?: RequestInit): Promise<DiscussionApiResult<T>> {
  try {
    const response = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      cache: 'no-store',
    });
    const body = (await response.json().catch(() => null)) as
      (T & { ok?: boolean; error?: string }) | null;
    if (!response.ok || body?.ok === false) {
      return {
        ok: false,
        status: response.status,
        data: null,
        error: body?.error ?? response.statusText,
      };
    }
    return { ok: true, status: response.status, data: body as T };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function fetchDiscussionRooms() {
  return call<{ rooms: DiscussionRoomSummary[]; accessRole?: string }>('/api/discussions');
}

export function createDiscussion(body: {
  goal: string;
  locale: DiscussionLocale;
  speaker: 'auto' | 'scripted' | 'reasoning';
  turn_delay_ms: number;
  tenant?: string;
}) {
  return call<{ room: DiscussionRoomState }>('/api/discussions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function sendDiscussionCommand(roomId: string, command: DiscussionCommand) {
  return call<{ room: DiscussionRoomState }>(
    `/api/discussions/${encodeURIComponent(roomId)}/command`,
    {
      method: 'POST',
      body: JSON.stringify(command),
    }
  );
}

const TERMINAL = new Set(['concluded', 'stopped', 'failed']);

export type StreamConnection = 'connecting' | 'live' | 'ended' | 'error';

/** Live room state over SSE, with a polling fallback if the stream drops. */
export function useDiscussionStream(roomId: string | null) {
  const [room, setRoom] = useState<DiscussionRoomState | null>(null);
  const [connection, setConnection] = useState<StreamConnection>('connecting');
  const [error, setError] = useState<string | null>(null);
  const failures = useRef(0);

  useEffect(() => {
    setRoom(null);
    setError(null);
    failures.current = 0;
    if (!roomId) return;
    setConnection('connecting');
    let closed = false;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const apply = (next: DiscussionRoomState) => {
      setRoom(next);
      setConnection(TERMINAL.has(next.status) ? 'ended' : 'live');
    };

    const startPolling = () => {
      if (closed || pollTimer) return;
      pollTimer = setInterval(async () => {
        const result = await fetchRoom(roomId);
        if (closed) return;
        if (result.ok && result.data) {
          apply(result.data.room);
          if (TERMINAL.has(result.data.room.status) && pollTimer) clearInterval(pollTimer);
        } else if (result.status === 403 || result.status === 404) {
          setError(result.error ?? 'not available');
          if (pollTimer) clearInterval(pollTimer);
        }
      }, 1500);
    };

    if (typeof EventSource === 'undefined') {
      startPolling();
    } else {
      source = new EventSource(`/api/discussions/${encodeURIComponent(roomId)}/stream`);
      source.addEventListener('state', (event) => {
        try {
          failures.current = 0;
          apply(JSON.parse((event as MessageEvent<string>).data) as DiscussionRoomState);
        } catch {
          /* ignore a torn frame; the next one carries the full state */
        }
      });
      source.addEventListener('end', () => {
        setConnection('ended');
        source?.close();
      });
      source.onerror = () => {
        failures.current += 1;
        if (failures.current >= 3) {
          source?.close();
          setConnection('error');
          startPolling();
        }
      };
    }
    return () => {
      closed = true;
      source?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [roomId]);

  return { room, connection, error, setRoom };
}

function fetchRoom(roomId: string) {
  return call<{ room: DiscussionRoomState }>(`/api/discussions/${encodeURIComponent(roomId)}`);
}
