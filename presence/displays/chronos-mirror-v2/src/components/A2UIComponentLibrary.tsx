import React from 'react';
import { Shield, Zap, Activity, Info } from 'lucide-react';

export const KyberionGauge = ({ label, value, unit }: { label: string, value: number, unit: string }) => {
  const percentage = Math.min(100, Math.max(0, value));
  return (
    <div className="flex flex-col gap-2 w-full">
      <div className="flex justify-between text-[10px] uppercase tracking-widest opacity-60">
        <span>{label}</span>
        <span>{value}{unit}</span>
      </div>
      <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden border border-white/10">
        <div 
          className="h-full bg-kyberion-gold transition-all duration-1000 ease-out shadow-[0_0_10px_rgba(212,175,55,0.5)]" 
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
};

export const KyberionLog = ({ title, lines }: { title: string, lines: string[] }) => {
  return (
    <div className="flex flex-col gap-3 w-full h-full">
      <div className="text-[10px] uppercase tracking-widest opacity-60 flex items-center gap-2">
        <Info size={12} /> {title}
      </div>
      <div className="flex-1 bg-black/40 rounded-xl p-4 font-mono text-[10px] space-y-1 overflow-y-auto border border-white/5">
        {lines.map((line, i) => (
          <div key={i} className="opacity-40 border-l border-kyberion-gold/20 pl-2">
            <span className="text-kyberion-gold/40 mr-2">[{new Date().toLocaleTimeString()}]</span>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
};
