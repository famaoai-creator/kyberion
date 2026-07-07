'use client';

import * as React from 'react';

type Setup = {
  surface_roles: Array<{ id: string; role_ja: string; tagline_ja: string; port: number; enabled: boolean }>;
  active_surfaces: Array<{ id: string; port?: number; enabled: boolean }>;
  reasoning_mode: string;
  model_tiers: Record<string, string>;
  commands: Record<string, string>;
};

export default function SetupPage() {
  const [setup, setSetup] = React.useState<Setup | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetch('/api/setup', { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload) => {
        if (!payload.ok) throw new Error(payload.error);
        setSetup(payload.setup);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error) return <div className="notice error">セットアップ情報の取得に失敗しました: {error}</div>;
  if (!setup) return <div className="pane-empty">確認しております…</div>;

  const reasoningReady = setup.reasoning_mode !== 'not-installed' && setup.reasoning_mode !== 'stub';

  return (
    <div className="pane-grid">
      <section className="pane" aria-label="オンボーディング">
        <h2>オンボーディング進捗</h2>
        <p className="pane-subtitle">Kyberion を使い始めるための確認項目です。</p>
        <div className="item-card">
          <p className="item-title">
            推論バックエンド
            <span className={`status-chip${reasoningReady ? '' : ' attention'}`}>
              {reasoningReady ? `準備完了 (${setup.reasoning_mode})` : '未設定'}
            </span>
          </p>
          {!reasoningReady ? <p className="item-body">設定コマンド: {setup.commands.reasoning}</p> : null}
        </div>
        {setup.surface_roles.map((role) => {
          const running = setup.active_surfaces.find((surface) => surface.id === role.id);
          return (
            <div key={role.id} className="item-card">
              <p className="item-title">
                {role.role_ja}({role.id})
                <span className={`status-chip${running?.enabled ? '' : ' attention'}`}>
                  {running ? (running.enabled ? `有効 · :${role.port}` : '無効') : 'マニフェスト外'}
                </span>
              </p>
              <p className="item-body">{role.tagline_ja}</p>
            </div>
          );
        })}
        <div className="item-meta">起動: {setup.commands.surfaces} / 初期化: {setup.commands.onboarding}</div>
      </section>

      <section className="pane" aria-label="拡張設定">
        <h2>拡張設定</h2>
        <p className="pane-subtitle">現在の構成の読み取りビューです(変更は各コマンドで)。</p>
        <div className="item-card">
          <p className="item-title">モデル振り分け(タスクの重さ → モデル)</p>
          <p className="item-body">
            {Object.entries(setup.model_tiers)
              .map(([tier, model]) => `${tier} → ${model}`)
              .join(' / ')}
          </p>
        </div>
        <div className="item-card">
          <p className="item-title">会社テンプレート</p>
          <p className="item-body">{setup.commands.company}</p>
        </div>
        <div className="item-card">
          <p className="item-title">会議の議事録</p>
          <p className="item-body">{setup.commands.minutes}</p>
        </div>
      </section>
    </div>
  );
}
