"use client";

import { CopilotKit, useCopilotAction } from "@copilotkit/react-core";
import { CopilotPopup } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";
import { Shield, Activity, Zap, Cpu, Sparkles } from "lucide-react";
import { useState } from "react";
import { KyberionGauge, KyberionLog } from "../components/A2UIComponentLibrary";

function MirrorContent() {
  const [surface, setSurface] = useState<any>(null);

  // Define the A2UI Action for the Agent
  useCopilotAction({
    name: "renderA2UISurface",
    description: "Renders a new A2UI surface or updates existing components on the Chronos Mirror.",
    parameters: [
      {
        name: "surfaceId",
        type: "string",
        description: "Unique ID for the surface",
        required: true,
      },
      {
        name: "title",
        type: "string",
        description: "Title of the surface",
      },
      {
        name: "components",
        type: "object[]",
        description: "List of components to render (Gauges, Logs, etc.)",
      }
    ],
    handler: async ({ surfaceId, title, components }) => {
      setSurface({ surfaceId, title, components });
      return `Surface ${surfaceId} rendered on Chronos Mirror.`;
    },
  });

  return (
    <main className="h-screen w-screen flex flex-col p-8 relative overflow-hidden">
      
      {/* Background Ambient Effects */}
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none opacity-20">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-kyberion-gold rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-900 rounded-full blur-[120px]" />
      </div>

      {/* Header */}
      <header className="flex justify-between items-center z-10 mb-8">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 kyberion-glass rounded-xl flex items-center justify-center border border-kyberion-gold/30">
            <Shield className="text-kyberion-gold w-6 h-6 shadow-glow" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tighter gold-glow uppercase">Chronos Mirror</h1>
            <p className="text-xs opacity-50 uppercase tracking-widest font-mono">Sovereign OS v2.0</p>
          </div>
        </div>
        <div className="flex gap-8 font-mono text-[10px] opacity-70 tracking-widest">
          <div className="flex items-center gap-2 text-green-500"><div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"/> SYSTEM: STABLE</div>
          <div className="flex items-center gap-2"><Zap size={12}/> LATENCY: 42ms</div>
          <div className="flex items-center gap-2"><Activity size={12}/> RESONANCE: 98.5%</div>
        </div>
      </header>

      {/* Main Grid */}
      <div className="flex-1 grid grid-cols-12 gap-6 z-10">
        
        {/* Left Panel: Stats */}
        <div className="col-span-3 flex flex-col gap-6">
          <section className="kyberion-glass rounded-2xl p-6 flex-1 flex flex-col">
            <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] mb-6 opacity-40">Core Subsystems</h2>
            <div className="flex-1 space-y-8">
              <KyberionGauge label="Integrity" value={98} unit="%" />
              <KyberionGauge label="Defense" value={85} unit="%" />
              <KyberionGauge label="Memory" value={42} unit="%" />
            </div>
          </section>
        </div>

        {/* Center: A2UI Generative Surface */}
        <div className="col-span-6 kyberion-glass rounded-3xl p-1 relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-kyberion-gold/5 to-transparent pointer-events-none" />
          <div className="w-full h-full rounded-[1.4rem] bg-black/40 border border-white/5 p-8 flex flex-col">
            <h2 className="text-[10px] font-bold uppercase tracking-[0.3em] mb-8 opacity-40 text-center flex items-center justify-center gap-3">
              <div className="h-px w-8 bg-kyberion-gold/20"/>
              {surface?.title || "Active Intelligence Surface"}
              <div className="h-px w-8 bg-kyberion-gold/20"/>
            </h2>
            
            <div className="flex-1 flex flex-col items-center justify-center relative">
              {!surface ? (
                <div className="text-center space-y-6">
                  <div className="w-16 h-16 rounded-full border-2 border-kyberion-gold/10 border-t-kyberion-gold/40 animate-spin mx-auto" />
                  <div className="text-kyberion-gold/30 italic text-sm tracking-wide">Awaiting Agent Manifestation...</div>
                </div>
              ) : (
                <div className="w-full h-full flex flex-col gap-8 animate-in fade-in zoom-in duration-700">
                  {surface.components?.map((c: any, i: number) => {
                    if (c.type === 'display:gauge') return <KyberionGauge key={i} {...c.props} />;
                    if (c.type === 'display:log') return <KyberionLog key={i} {...c.props} />;
                    return <div key={i} className="text-xs opacity-50">Unknown component: {c.type}</div>;
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Panel: Operations */}
        <div className="col-span-3 flex flex-col gap-6">
          <section className="kyberion-glass rounded-2xl p-6 flex-1">
            <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] mb-6 opacity-40">Active Missions</h2>
            <div className="space-y-4">
              <div className="p-4 bg-white/5 border border-kyberion-gold/10 rounded-xl">
                <div className="text-[10px] font-bold text-kyberion-gold mb-1">REBUILD-CHRONOS-MIRROR</div>
                <div className="text-[9px] opacity-40 uppercase tracking-tighter">Status: UI_SYNCHRONIZATION</div>
              </div>
            </div>
          </section>
          <section className="kyberion-glass rounded-2xl p-6 h-1/3">
            <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] mb-4 opacity-40 text-blue-400">Sovereign Audit</h2>
            <div className="font-mono text-[9px] space-y-2 opacity-30 leading-relaxed">
              <div>&gt; [10:18:32] INIT_CORE_ENGINE</div>
              <div>&gt; [10:18:33] PTY_BRIDGE_UP</div>
              <div>&gt; [10:18:35] ACP_PROTOCOL_ACTIVE</div>
              <div className="text-kyberion-gold/60">&gt; [LIVE] LISTENING_FOR_STIMULI</div>
            </div>
          </section>
        </div>

      </div>

      <CopilotPopup
        instructions="You are the Kyberion Sovereign Assistant. Help the Sovereign manage the ecosystem. Use 'renderA2UISurface' to show relevant data surfaces on the mirror."
        labels={{
          title: "Sovereign Link",
          initial: "Welcome, Sovereign. The mirror is ready for your command.",
        }}
        defaultOpen={true}
      />
    </main>
  );
}

export default function ChronosMirrorV2() {
  return (
    <CopilotKit runtimeUrl="/api/copilotkit">
      <MirrorContent />
    </CopilotKit>
  );
}
