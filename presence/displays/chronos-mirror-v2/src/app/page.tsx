"use client";

import { Shield, Cpu, Radar, Bot, ActivitySquare, Wrench, PanelsTopLeft, ChevronDown, ChevronRight, ClipboardCheck, CalendarClock } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { A2UIRenderer } from "../components/A2UIComponentLibrary";
import { FocusedOperatorView } from "../components/FocusedOperatorView";
import { SovereignChat } from "../components/SovereignChat";
import { AgentPanel } from "../components/AgentPanel";
import { FirstRunBanner } from "../components/FirstRunBanner";
import { IdentityBadge } from "../components/IdentityBadge";
import { MissionIntelligence } from "../components/MissionIntelligence";
import { MISSION_CYCLE, OPERATOR_VIEW_LINKS, SURFACE_ROLES } from "../lib/operator-console";
import { uxText } from "../lib/ux-vocabulary";
import { useChronosLocale } from "../lib/hooks";

type QuickAction = {
  label: string;
  query: string;
  icon: string;
  tone: "observe" | "verify" | "operate";
};

type QuickActionGroup = {
  title: string;
  hint: string;
  icon: typeof Radar;
  accent: string;
  accentText: string;
  actions: QuickAction[];
};

type StatusCard = {
  label: string;
  value: string;
  detail: string;
  icon: typeof Shield;
  accent: string;
  targetId: string;
};


const QUICK_ACTION_GROUPS: QuickActionGroup[] = [
  {
    title: "Prepare",
    hint: "Check the local toolchain and readiness manifests before you start the operator flow.",
    icon: ClipboardCheck,
    accent: "from-emerald-400/16 via-emerald-300/8 to-transparent",
    accentText: "text-emerald-200/85",
    actions: [
      { label: "Prereq Check", query: "chronos://quick-action/prereq-check", icon: "🧰", tone: "verify" },
      { label: "Setup Report", query: "chronos://quick-action/setup-report", icon: "📑", tone: "verify" },
      { label: "Doctor", query: "chronos://quick-action/doctor", icon: "🩺", tone: "verify" },
      { label: "Surface Setup", query: "chronos://quick-action/surfaces-setup", icon: "🛰", tone: "verify" },
    ],
  },
  {
    title: "Schedule",
    hint: "Run scheduled generation jobs or inspect the current schedule registry.",
    icon: CalendarClock,
    accent: "from-violet-400/16 via-violet-300/8 to-transparent",
    accentText: "text-violet-200/85",
    actions: [
      { label: "Schedule Tick", query: "chronos://quick-action/schedule-tick", icon: "⏱", tone: "operate" },
      { label: "Schedule List", query: "chronos://quick-action/schedule-list", icon: "🗂", tone: "observe" },
    ],
  },
  {
    title: "Observe",
    hint: "Open governed readouts before you intervene.",
    icon: Radar,
    accent: "from-cyan-400/16 via-cyan-300/8 to-transparent",
    accentText: "text-cyan-200/85",
    actions: [
      { label: "Dashboard", query: "chronos://quick-action/dashboard", icon: "📊", tone: "observe" },
      { label: "Missions", query: "chronos://quick-action/missions", icon: "🎯", tone: "observe" },
      { label: "Agents", query: "chronos://quick-action/agents", icon: "🤖", tone: "observe" },
      { label: "Audit Log", query: "chronos://quick-action/audit-log", icon: "📋", tone: "observe" },
    ],
  },
  {
    title: "Verify",
    hint: "Run deterministic checks when the control plane needs proof.",
    icon: ActivitySquare,
    accent: "from-amber-300/18 via-amber-200/8 to-transparent",
    accentText: "text-amber-200/85",
    actions: [
      { label: "Vital Check", query: "chronos://quick-action/vital-check", icon: "💓", tone: "verify" },
      { label: "Diagnostics", query: "chronos://quick-action/diagnostics", icon: "🔍", tone: "verify" },
      { label: "Capability Audit", query: "chronos://quick-action/capability-audit", icon: "🧩", tone: "verify" },
      { label: "Provider Check", query: "chronos://quick-action/provider-check", icon: "🔌", tone: "verify" },
    ],
  },
  {
    title: "Operate",
    hint: "Escalate only when mission flow, runtime health, or delivery is blocked.",
    icon: Wrench,
    accent: "from-rose-400/16 via-orange-300/8 to-transparent",
    accentText: "text-orange-200/85",
    actions: [
      { label: "Build & Test", query: "chronos://quick-action/build-test", icon: "🔨", tone: "operate" },
      { label: "Policies", query: "chronos://quick-action/policies", icon: "🛡", tone: "operate" },
      { label: "Upgrade Check", query: "node dist/scripts/run_pipeline.js --input pipelines/system-upgrade-check.json を実行して、アップデートの有無を表示して", icon: "⬆", tone: "operate" },
      { label: "Knowledge", query: "chronos://quick-action/knowledge", icon: "🧠", tone: "operate" },
    ],
  },
];

const STATUS_CARDS: StatusCard[] = [
  {
    label: "Needs Attention",
    value: "Exceptions",
    detail: "Start with mission blockers, runtime incidents, and delivery exceptions.",
    icon: Shield,
    accent: "border-amber-200/16 bg-amber-300/8 text-amber-100",
    targetId: "mission-control-plane",
  },
  {
    label: "Toolchain",
    value: "Preflight",
    detail: "Confirm local prerequisites and setup reports before you work from source.",
    icon: ClipboardCheck,
    accent: "border-emerald-200/16 bg-emerald-300/8 text-emerald-100",
    targetId: "operator-quick-actions",
  },
  {
    label: "Schedules",
    value: "Registry",
    detail: "Inspect and tick scheduled generation jobs from the operator console.",
    icon: CalendarClock,
    accent: "border-violet-200/16 bg-violet-300/8 text-violet-100",
    targetId: "operator-quick-actions",
  },
  {
    label: "Runtime Governance",
    value: "Supervisor",
    detail: "Managed runtimes, lease ownership, and remediation live here.",
    icon: Bot,
    accent: "border-cyan-200/16 bg-cyan-300/8 text-cyan-100",
    targetId: "runtime-lease-doctor",
  },
  {
    label: "Delivery",
    value: "Outbox",
    detail: "Slack and Chronos share one operator-visible delivery queue.",
    icon: Radar,
    accent: "border-rose-200/16 bg-rose-300/8 text-rose-100",
    targetId: "recent-surface-outbox",
  },
];

export default function ChronosMirrorV2() {
  const locale = useChronosLocale();
  const [surface, setSurface] = useState<any>(null);
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [focusedOperatorView, setFocusedOperatorView] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    taxonomy: false,
    cycle: false,
    views: true
  });
  const sendQueryRef = useRef<((q: string) => void) | null>(null);

  const toggleSection = (key: string) => {
    setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleReady = useCallback((fn: (q: string) => void) => {
    sendQueryRef.current = fn;
  }, []);

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
    if (message.type && message.type.startsWith("display:")) {
      const id = message.id || `auto-${Date.now()}`;
      setSurface({
        surfaceId: "auto-surface",
        title: "Dashboard",
        components: [{ id, type: message.type, props: message.props || message }],
      });
    }
  }, []);

  const handleQuickAction = useCallback((query: string) => {
    sendQueryRef.current?.(query);
  }, []);

  const handleSectionJump = useCallback((targetId: string) => {
    const element = document.getElementById(targetId);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const handleOperatorViewOpen = useCallback((targetId: string) => {
    setFocusedOperatorView(targetId);
    if (surface) {
      setSurface(null);
    }
  }, [surface]);

  const activeSurfaceTitle = useMemo(
    () => surface?.title || uxText("chronos_mission_intelligence", "Mission Intelligence", locale),
    [surface?.title, locale],
  );

  return (
    <main className="min-h-screen w-screen overflow-hidden bg-[#020617] text-white">
      <div className="absolute inset-0 pointer-events-none opacity-60">
        <div className="absolute left-[-8%] top-[-6%] h-[32rem] w-[32rem] rounded-full bg-cyan-500/10 blur-[160px]" />
        <div className="absolute top-[18%] right-[12%] h-[20rem] w-[20rem] rounded-full bg-cyan-400/5 blur-[150px]" />
        <div className="absolute bottom-[-12%] left-[32%] h-[26rem] w-[26rem] rounded-full bg-slate-500/5 blur-[160px]" />
      </div>
      <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(to_right,rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:88px_88px] opacity-[0.06]" />
      <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(180deg,rgba(255,248,225,0.05)_0%,transparent_18%,transparent_82%,rgba(148,163,184,0.04)_100%)]" />

      <div className="relative z-10 flex min-h-screen flex-col gap-6 p-4 md:p-6 xl:h-screen xl:overflow-hidden">
        <header className="px-1 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-400/30 bg-cyan-400/10">
                <Shield className="h-5 w-5 text-cyan-400" />
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[0.3em] text-white/40 font-bold">Chronos Mirror</div>
                <h1 className="text-lg font-bold tracking-tight text-white/90">Control Plane</h1>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <IdentityBadge />
              <button
                onClick={() => setAgentPanelOpen(true)}
                className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-white/70 transition hover:bg-white/10 hover:text-cyan-400"
              >
                <Cpu size={12} />
                <span>{uxText("chronos_agent_runtimes", "Agent Runtimes", locale)}</span>
              </button>
            </div>
          </div>
        </header>

        <FirstRunBanner />

        <div className="grid flex-1 gap-6 min-h-0 xl:grid-cols-[280px,1fr]">
          <aside className="min-h-0 xl:max-h-[calc(100vh-8rem)] xl:overflow-y-auto xl:pr-2 chronos-scroll">
            <div className="flex flex-col gap-6">
              <section id="operator-quick-actions" className="kyberion-glass rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-4 md:p-5">
                <div className="mb-4 flex items-center justify-between">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.28em] text-white/45">{uxText("chronos_quick_actions", "Quick Actions", locale)}</div>
                    <div className="mt-1 text-sm text-slate-200/65">{uxText("chronos_grouped_by_operator_intent", "These drive the active A2UI surface on the right.", locale)}</div>
                  </div>
                </div>

                <div className="space-y-5">
                  {QUICK_ACTION_GROUPS.map((group) => {
                    const Icon = group.icon;
                    return (
                      <div key={group.title} className="overflow-hidden rounded-2xl border border-white/8 bg-black/20">
                        <div className={`bg-gradient-to-r ${group.accent} px-3 py-3`}>
                          <div className="flex items-start gap-3">
                            <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/6">
                              <Icon size={14} className={group.accentText} />
                            </div>
                            <div>
                              <div className={`text-[11px] font-semibold uppercase tracking-[0.2em] ${group.accentText}`}>{group.title}</div>
                              <div className="mt-1 text-[11px] leading-5 text-slate-200/58">{group.hint}</div>
                            </div>
                          </div>
                        </div>

                        <div className="grid gap-2 p-3">
                          {group.actions.map((action) => (
                            <button
                              key={action.label}
                              onClick={() => handleQuickAction(action.query)}
                              className="flex items-center justify-between rounded-xl border border-white/8 bg-slate-950/55 px-3 py-2 text-left transition hover:border-white/18 hover:bg-slate-900/80"
                            >
                              <div className="flex items-center gap-3">
                                <div className="text-sm">{action.icon}</div>
                                <div>
                                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/88">{action.label}</div>
                                  <div className="text-[10px] uppercase tracking-[0.14em] text-slate-400/70">{action.tone}</div>
                                </div>
                              </div>
                              <div className="text-[10px] uppercase tracking-[0.2em] text-white/38">Run</div>
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="grid gap-3 md:grid-cols-3 xl:grid-cols-1">
                {STATUS_CARDS.map((card) => {
                  const Icon = card.icon;
                  return (
                    <button
                      key={card.label}
                      type="button"
                      onClick={() => handleSectionJump(card.targetId)}
                      className="kyberion-glass rounded-2xl border border-white/8 p-4 text-left transition hover:border-white/16 hover:bg-white/5"
                    >
                      <div className="flex items-center gap-3">
                        <div className={`flex h-10 w-10 items-center justify-center rounded-xl border ${card.accent}`}>
                          <Icon size={15} />
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.22em] text-slate-400/80">{card.label}</div>
                          <div className="mt-1 text-base font-semibold text-white/90">{card.value}</div>
                        </div>
                      </div>
                      <p className="mt-3 text-[11px] leading-5 text-slate-200/58">{card.detail}</p>
                      <div className="mt-3 text-[10px] uppercase tracking-[0.2em] text-white/35">{uxText("chronos_jump_to_section", "Jump to section", locale)}</div>
                    </button>
                  );
                })}
              </section>

              <section className="kyberion-glass rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(247,240,223,0.05),rgba(255,255,255,0.02))] p-4">
                <button 
                  onClick={() => toggleSection('views')}
                  className="w-full flex items-center justify-between text-[10px] uppercase tracking-[0.28em] text-white/45 hover:text-white/80 transition"
                >
                  <span>Operator Views</span>
                  {expandedSections.views ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                {expandedSections.views && (
                  <>
                    <div className="mt-2 text-sm text-slate-200/68">
                      Use this menu to switch the main console into a single focused operator view, including the runtime map.
                    </div>
                    <div className="mt-4 grid gap-2">
                      <button
                        type="button"
                        onClick={() => setFocusedOperatorView(null)}
                        className={`rounded-2xl border px-3 py-3 text-left transition ${
                          focusedOperatorView === null
                            ? "border-cyan-400/30 bg-cyan-400/10"
                            : "border-white/8 bg-black/20 hover:border-white/16 hover:bg-white/[0.05]"
                        }`}
                      >
                        <div className="text-[10px] uppercase tracking-[0.18em] text-white/52">Full Console</div>
                        <div className="mt-2 text-[11px] leading-5 text-slate-200/56">Show the complete control surface with all operator sections.</div>
                      </button>
                      {OPERATOR_VIEW_LINKS.map((view) => (
                        <button
                          key={view.targetId}
                          type="button"
                          onClick={() => handleOperatorViewOpen(view.targetId)}
                          className={`rounded-2xl border px-3 py-3 text-left transition ${
                            focusedOperatorView === view.targetId
                              ? "border-cyan-400/30 bg-cyan-400/10"
                              : "border-white/8 bg-black/20 hover:border-white/16 hover:bg-white/[0.05]"
                          }`}
                        >
                          <div className="text-[10px] uppercase tracking-[0.18em] text-white/52">{view.label}</div>
                          <div className="mt-2 text-[11px] leading-5 text-slate-200/56">{view.detail}</div>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </section>

              <section className="kyberion-glass rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(247,240,223,0.05),rgba(255,255,255,0.02))] p-4 opacity-60 hover:opacity-100 transition">
                <button 
                  onClick={() => toggleSection('taxonomy')}
                  className="w-full flex items-center justify-between text-[10px] uppercase tracking-[0.28em] text-white/45 hover:text-white/80 transition"
                >
                  <span>Surface Taxonomy</span>
                  {expandedSections.taxonomy ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                {expandedSections.taxonomy && (
                  <>
                    <div className="mt-2 text-sm text-slate-200/68">
                      Every surface connects people and agent execution in a different mode. Chronos is the control surface, while A2UI provides drill-down work surfaces.
                    </div>
                    <div className="mt-4 space-y-3">
                      {SURFACE_ROLES.map((role) => (
                        <div key={role.label} className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-[10px] uppercase tracking-[0.18em] text-white/44">{role.label}</div>
                            <div className="text-[10px] uppercase tracking-[0.18em] text-cyan-100/72">{role.value}</div>
                          </div>
                          <div className="mt-2 text-[11px] leading-5 text-slate-200/58">{role.detail}</div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </section>

              <section className="kyberion-glass rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(247,240,223,0.05),rgba(255,255,255,0.02))] p-4 opacity-60 hover:opacity-100 transition">
                <button 
                  onClick={() => toggleSection('cycle')}
                  className="w-full flex items-center justify-between text-[10px] uppercase tracking-[0.28em] text-white/45 hover:text-white/80 transition"
                >
                  <span>Mission Cycle</span>
                  {expandedSections.cycle ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                {expandedSections.cycle && (
                  <>
                    <div className="mt-2 text-sm text-slate-200/68">
                      Kyberion should always make this loop legible: a request becomes a mission, execution stays explainable, and the result remains inspectable and reusable.
                    </div>
                    <div className="mt-4 grid gap-2">
                      {MISSION_CYCLE.map((step, index) => (
                        <div key={step.label} className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
                          <div className="flex items-center gap-3">
                            <div className="flex h-6 w-6 items-center justify-center rounded-full border border-cyan-400/20 bg-cyan-400/10 text-[10px] font-semibold text-cyan-400">
                              {index + 1}
                            </div>
                            <div className="text-[10px] uppercase tracking-[0.18em] text-white/50">{step.label}</div>
                          </div>
                          <div className="mt-2 text-[11px] leading-5 text-slate-200/58">{step.detail}</div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </section>
            </div>
          </aside>

          <section className="kyberion-glass flex min-h-[60vh] min-h-0 flex-col overflow-hidden rounded-[30px] border border-white/10 bg-[linear-gradient(180deg,rgba(247,240,223,0.035),rgba(255,255,255,0.02))] xl:max-h-[calc(100vh-11rem)]">
            <div className="flex items-center justify-between border-b border-white/8 px-5 py-4 md:px-6">
              <div>
                <div className="text-[10px] uppercase tracking-[0.34em] text-stone-200/42">Active Surface</div>
                <div className="mt-1 text-lg font-semibold tracking-tight text-white/92">{activeSurfaceTitle}</div>
              </div>
              <div className="flex items-center gap-2 rounded-full border border-white/8 bg-black/25 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-slate-300/60">
                <PanelsTopLeft size={12} />
                <span>{surface ? "a2ui drill-down" : focusedOperatorView ? "focused operator view" : "default operator view"}</span>
              </div>
            </div>

            <div className="chronos-scroll min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
              {!surface ? (
                focusedOperatorView ? (
                  <FocusedOperatorView
                    viewId={focusedOperatorView as
                      | "needs-attention"
                      | "mission-control-plane"
                      | "runtime-topology-map"
                      | "runtime-lease-doctor"
                      | "recent-surface-outbox"
                      | "secret-approval-queue"
                      | "owner-summaries"}
                    onBack={() => setFocusedOperatorView(null)}
                  />
                ) : (
                  <MissionIntelligence />
                )
              ) : (
                <div className="flex flex-col gap-6">
                  {surface.components?.map((component: any, index: number) => (
                    <A2UIRenderer key={component.id || index} type={component.type} props={component.props || {}} />
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        <SovereignChat onA2UIMessage={handleA2UIMessage} onReady={handleReady} />
        <AgentPanel isOpen={agentPanelOpen} onClose={() => setAgentPanelOpen(false)} />
      </div>
    </main>
  );
}
