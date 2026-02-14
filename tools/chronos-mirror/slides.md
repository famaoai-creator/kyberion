---
theme: default
background: https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&q=80&w=2072
class: text-center
highlighter: shiki
drawings:
  persist: false
transition: slide-left
title: Chronos Mirror - Gemini Reality Interface
---

# Chronos Mirror
### Gemini Reality-Mirroring Interface v1.0

<div class="pt-8">
  <CommandCenter />
</div>

<div class="pt-4">
  <span @click="$slidev.nav.next" class="px-2 py-1 rounded cursor-pointer hover:bg-white hover:bg-opacity-10 text-xs">
    詳細ログとナレッジ探索へ <carbon:arrow-right class="inline"/>
  </span>
</div>

---
layout: center
---

<TemporalSlider />

---
layout: center
---

# 🏗️ 移行戦略: VoltMX to React
`Strangler Fig Pattern Implementation`

<div class="grid grid-cols-3 gap-4 mt-8">
  <div class="p-3 border border-gray-700 rounded bg-gray-900 bg-opacity-50">
    <h4 class="text-xs font-bold text-blue-300 mb-2">1. Inventory</h4>
    <p class="text-[10px] text-gray-400 text-left">既存資産の棚卸し。WidgetとLogicの分類完了。</p>
  </div>
  <div class="p-3 border border-blue-500 rounded bg-blue-900 bg-opacity-20 animate-pulse">
    <h4 class="text-xs font-bold text-blue-300 mb-2 text-center">2. API Standard</h4>
    <p class="text-[10px] text-gray-200 text-center font-bold">In Progress</p>
    <p class="text-[9px] text-gray-400 text-left mt-1">Foundry API の標準JSON出力化。</p>
  </div>
  <div class="p-3 border border-gray-700 rounded bg-gray-900 bg-opacity-50">
    <h4 class="text-xs font-bold text-gray-500 mb-2 text-center">3. React Conversion</h4>
    <p class="text-[10px] text-gray-600 text-center">Waiting</p>
  </div>
</div>

<div class="mt-8 bg-blue-900 bg-opacity-10 p-4 border-l-4 border-blue-400">
  <p class="text-xs italic text-blue-200">"APIレイヤーを標準化することで、フロントエンドの疎結合化を実現する。"</p>
</div>

---

# ⚖️ ACE 意思決定アーカイブ (Consensus Log)
`work/committee/minutes.md`

<div class="space-y-4">
  <div class="bg-gray-900 p-3 rounded border-l-4 border-red-500">
    <div class="flex justify-between text-[10px] text-gray-500">
      <span>Topic: テストスキップ提案の是非</span>
      <span>2026-02-14</span>
    </div>
    <p class="text-red-400 font-bold mt-1 uppercase">Decision: NO-GO</p>
    <p class="text-[11px] text-gray-300 mt-1">IPA非機能要求 S1リスク（可用性）を回避。段階的移行への変更を命じた。</p>
  </div>

  <div class="bg-gray-900 p-3 rounded border-l-4 border-yellow-500 opacity-80">
    <div class="flex justify-between text-[10px] text-gray-500">
      <span>Topic: multi-agent-shogun 移植判定</span>
      <span>2026-02-14</span>
    </div>
    <p class="text-yellow-400 font-bold mt-1 uppercase">Decision: YELLOW-CARD</p>
    <p class="text-[11px] text-gray-300 mt-1">PII流出懸念があるが、ビジネス緊急度を優先。24時間以内のスキャナー実装を負債として登録。</p>
  </div>
</div>

---

# 🛡️ PMO ガバナンス・スタンダード
`PMBOK v7 & IPA Bridge`

<div class="grid grid-cols-2 gap-8 text-left mt-4">
  <div>
    <h3 class="text-sm font-bold text-purple-400 mb-2">PMBOK v7 重点原則</h3>
    <ul class="text-[10px] space-y-2 list-disc list-inside text-gray-300">
      <li><b>Value</b>: 常にビジネスメリットを問い直す</li>
      <li><b>Complexity</b>: 依存関係の輻輳を分割管理</li>
      <li><b>Quality</b>: IPAグレードを設計段階から注入</li>
    </ul>
  </div>
  <div>
    <h3 class="text-sm font-bold text-purple-400 mb-2">ステークホルダー制御</h3>
    <div class="bg-gray-800 p-2 rounded text-[9px]">
      <p class="text-blue-300 font-bold">Manage Closely:</p>
      <p class="text-gray-400">経営層, プロジェクトスポンサー</p>
      <p class="text-blue-300 font-bold mt-2">External Vendor:</p>
      <p class="text-gray-400">RACIマトリクスによる責任の明確化</p>
    </div>
  </div>
</div>

---

# 🎨 UI/UX 設計図 (ux-visualizer)
`PetStore-FrontEnd Analysis`

<div class="flex gap-4 items-center justify-center">
  <div class="text-center">
    <p class="text-[10px] text-gray-500 mb-2">Full User Journey</p>
    <img src="../external/petstore_full_journey.svg" class="h-64 rounded border border-gray-700 shadow-xl" />
  </div>
  <div class="text-center">
    <p class="text-[10px] text-gray-500 mb-2">Hover Interaction State</p>
    <img src="../external/petstore_full_visual.svg" class="h-64 rounded border border-gray-700 shadow-xl" />
  </div>
</div>

---

# ⏰ オペレーション状況 (Routine Tasks)
`work/tasks/status.json`

<div class="grid grid-cols-2 gap-4 mt-4">
  <div class="p-4 bg-gray-900 rounded">
    <h3 class="text-xs font-bold text-gray-400 mb-4 uppercase">Completed Today</h3>
    <div class="space-y-2">
      <div class="flex items-center gap-2 text-[11px] text-green-400"><carbon:checkmark-filled/> 出勤登録</div>
      <div class="flex items-center gap-2 text-[11px] text-green-400"><carbon:checkmark-filled/> 退勤登録</div>
      <div class="flex items-center gap-2 text-[11px] text-green-400"><carbon:checkmark-filled/> ナレッジ整合性チェック</div>
    </div>
  </div>
  <div class="p-4 bg-gray-900 rounded">
    <h3 class="text-xs font-bold text-gray-400 mb-4 uppercase">Upcoming / Nightly</h3>
    <div class="space-y-2">
      <div class="flex items-center gap-2 text-[11px] text-gray-500"><carbon:calendar/> 日報の作成 (23:59)</div>
      <div class="flex items-center gap-2 text-[11px] text-gray-500"><carbon:security/> 週次セキュリティ監査 (Next Mon)</div>
    </div>
  </div>
</div>

---
layout: center
---

# 🔎 ナレッジ・エクスプローラー
`knowledge/` 配下の全191ドキュメントを動的に探索

<KnowledgeBrowser />

---
layout: center
---

# 🧠 エージェント・インタラクション・ハブ
ブラウザからエージェントの「思考」と「行動」を指揮

<AgentConverse />

<div class="mt-4 text-[9px] text-gray-500 flex justify-center gap-8 italic">
  <span>💡 「セキュリティ状況を分析して」</span>
  <span>💡 「技術負債の最新レポートを出して」</span>
  <span>💡 「移行計画のボトルネックを特定して」</span>
</div>

---
layout: center
class: text-center
---

# 🚀 Next Evolution
## Reality-Mirroring Interface

<div class="mt-12 text-sm text-gray-400 italic">
  "このポータルは、私とあなたの思考が同期する場所です。"
</div>

<div class="mt-8 flex justify-center gap-4">
  <div class="px-4 py-2 border border-gray-700 rounded text-[10px]">Temporal Slider (Planned)</div>
  <div class="px-4 py-2 border border-gray-700 rounded text-[10px]">Live summoning (Ready)</div>
</div>
