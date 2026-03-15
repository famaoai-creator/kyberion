"use client";

import { Shield, Cpu } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { A2UIRenderer } from "../components/A2UIComponentLibrary";
import { SovereignChat } from "../components/SovereignChat";
import { AgentPanel } from "../components/AgentPanel";

const QUICK_ACTIONS = [
  { label: "Dashboard", query: "git status と git log --oneline -10 を実行して、ブランチ状態・最近のコミット・未コミット変更のサマリをダッシュボード表示して", icon: "📊" },
  { label: "Vital Check", query: "node dist/scripts/run_pipeline.js --input pipelines/vital-check.json を実行して結果を表示して", icon: "💓" },
  { label: "Diagnostics", query: "node dist/scripts/run_pipeline.js --input pipelines/system-diagnostics.json を実行して結果を表示して", icon: "🔍" },
  { label: "Build & Test", query: "pnpm run build と pnpm test を実行して、ビルド結果とテスト結果をステータス表示して", icon: "🔨" },
  { label: "Missions", query: "active/missions/registry.json を読んでミッション一覧をテーブル表示して。なければ「ミッションなし」と表示", icon: "🎯" },
  { label: "Agents", query: "knowledge/agents/ 配下のエージェント定義を一覧表示して。各エージェントのID、プロバイダー、モデル、capabilitiesをテーブルで", icon: "🤖" },
  { label: "Audit Log", query: "evidence/audit/ 配下の最新の監査ログファイルを読んで、直近20件のイベントをタイムライン表示して", icon: "📋" },
  { label: "Policies", query: "knowledge/governance/agent-policies.yaml を読んで、ポリシー一覧をテーブル表示して", icon: "🛡" },
  { label: "Capability Audit", query: "node dist/scripts/run_pipeline.js --input knowledge/public/governance/pipelines/code-skill-audit.json を実行して結果を表示して", icon: "🧩" },
  { label: "Provider Check", query: "node dist/scripts/run_pipeline.js --input pipelines/agent-provider-check.json を実行して、各プロバイダーの状態をステータス表示して", icon: "🔌" },
  { label: "Upgrade Check", query: "node dist/scripts/run_pipeline.js --input pipelines/system-upgrade-check.json を実行して、アップデートの有無を表示して", icon: "⬆" },
  { label: "Git History", query: "git log --oneline -20 を実行して、コミット履歴をタイムライン表示して", icon: "📡" },
  { label: "Knowledge", query: "find knowledge/ -name '*.md' -o -name '*.json' | head -30 を実行して、ナレッジファイルをリスト表示して。ディレクトリ別にグループ化", icon: "🧠" },
];

export default function ChronosMirrorV2() {
  const [surface, setSurface] = useState<any>(null);
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const sendQueryRef = useRef<((q: string) => void) | null>(null);
  const handleReady = useCallback((fn: (q: string) => void) => { sendQueryRef.current = fn; }, []);

  const handleA2UIMessage = useCallback((message: any) => {
    if (message.createSurface) {
      setSurface({ surfaceId: message.createSurface.surfaceId, title: message.createSurface.title, components: [] });
    }
    if (message.updateComponents) {
      setSurface((prev: any) => ({
        surfaceId: message.updateComponents.surfaceId,
        title: prev?.title || message.updateComponents.surfaceId,
        components: message.updateComponents.components,
      }));
    }
    if (message.deleteSurface) {
      setSurface(null);
    }
    // Handle flat component (no wrapper, just {type, props} directly)
    if (message.type && message.type.startsWith('display:')) {
      const id = message.id || `auto-${Date.now()}`;
      setSurface({
        surfaceId: 'auto-surface',
        title: 'Dashboard',
        components: [{ id, type: message.type, props: message.props || message }],
      });
    }
  }, []);

  const handleQuickAction = (query: string) => {
    sendQueryRef.current?.(query);
  };

  return (
    <main className="h-screen w-screen flex flex-col p-6 relative overflow-hidden">

      {/* Background */}
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none opacity-20">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-kyberion-gold rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-900 rounded-full blur-[120px]" />
      </div>

      {/* Header */}
      <header className="flex justify-between items-center z-10 mb-6">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 kyberion-glass rounded-xl flex items-center justify-center border border-kyberion-gold/30">
            <Shield className="text-kyberion-gold w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tighter gold-glow uppercase">Chronos Mirror</h1>
            <p className="text-[10px] opacity-40 uppercase tracking-widest font-mono">Sovereign OS v2.0</p>
          </div>
        </div>
        <button
          onClick={() => setAgentPanelOpen(true)}
          className="flex items-center gap-2 px-3 py-1.5 kyberion-glass rounded-lg border border-white/5 hover:border-kyberion-gold/30 hover:bg-kyberion-gold/10 transition text-[10px] uppercase tracking-widest opacity-60 hover:opacity-100"
        >
          <Cpu size={12} />
          <span>Agents</span>
        </button>
      </header>

      {/* Quick Actions */}
      <div className="flex gap-2 mb-6 z-10 flex-wrap">
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.label}
            onClick={() => handleQuickAction(action.query)}
            className="flex items-center gap-1.5 px-3 py-1.5 kyberion-glass rounded-lg border border-white/5 hover:border-kyberion-gold/30 hover:bg-kyberion-gold/10 transition text-[10px] uppercase tracking-widest opacity-60 hover:opacity-100"
          >
            <span>{action.icon}</span>
            <span>{action.label}</span>
          </button>
        ))}
      </div>

      {/* A2UI Surface - Full Width */}
      <div className="flex-1 z-10 kyberion-glass rounded-3xl p-1 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-kyberion-gold/5 to-transparent pointer-events-none" />
        <div className="w-full h-full rounded-[1.4rem] bg-black/40 border border-white/5 p-8 flex flex-col overflow-y-auto">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.3em] mb-6 opacity-40 text-center flex items-center justify-center gap-3">
            <div className="h-px w-8 bg-kyberion-gold/20"/>
            {surface?.title || "Active Intelligence Surface"}
            <div className="h-px w-8 bg-kyberion-gold/20"/>
          </h2>

          <div className="flex-1 flex flex-col items-center justify-center relative">
            {!surface ? (
              <div className="text-center space-y-4">
                <div className="text-kyberion-gold/20 text-4xl">⬡</div>
                <div className="text-kyberion-gold/30 italic text-sm tracking-wide">
                  Use the quick actions above or chat to query the system.
                </div>
              </div>
            ) : (
              <div className="w-full flex flex-col gap-6">
                {surface.components?.map((c: any, i: number) => (
                  <A2UIRenderer key={c.id || i} type={c.type} props={c.props || {}} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Chat */}
      <SovereignChat onA2UIMessage={handleA2UIMessage} onReady={handleReady} />

      {/* Agent Management Panel */}
      <AgentPanel isOpen={agentPanelOpen} onClose={() => setAgentPanelOpen(false)} />
    </main>
  );
}
