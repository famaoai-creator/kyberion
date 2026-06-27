"use client";

import type { ReactNode } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, Info, Radar } from "lucide-react";

type SurfaceStatusTone = "neutral" | "info" | "warning" | "error" | "success";

const TONE_STYLES: Record<SurfaceStatusTone, { border: string; bg: string; text: string; icon: ReactNode }> = {
  neutral: {
    border: "border-white/10",
    bg: "bg-black/20",
    text: "text-white/72",
    icon: <Radar size={14} className="text-cyan-100/75" />,
  },
  info: {
    border: "border-cyan-300/15",
    bg: "bg-cyan-400/[0.06]",
    text: "text-cyan-50/80",
    icon: <Info size={14} className="text-cyan-200/80" />,
  },
  warning: {
    border: "border-amber-300/18",
    bg: "bg-amber-400/[0.06]",
    text: "text-amber-50/82",
    icon: <AlertTriangle size={14} className="text-amber-200/82" />,
  },
  error: {
    border: "border-rose-300/18",
    bg: "bg-rose-500/[0.08]",
    text: "text-rose-50/84",
    icon: <AlertTriangle size={14} className="text-rose-200/85" />,
  },
  success: {
    border: "border-emerald-300/18",
    bg: "bg-emerald-400/[0.06]",
    text: "text-emerald-50/82",
    icon: <CheckCircle2 size={14} className="text-emerald-200/85" />,
  },
};

export function SurfaceStatusPanel({
  eyebrow,
  title,
  detail,
  tone = "neutral",
  meta,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
}: {
  eyebrow?: string;
  title: string;
  detail: string;
  tone?: SurfaceStatusTone;
  meta?: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
}) {
  const style = TONE_STYLES[tone];

  return (
    <div className={`rounded-[24px] border ${style.border} ${style.bg} px-5 py-4`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-black/25">
          {style.icon}
        </div>
        <div className="min-w-0 flex-1">
          {eyebrow ? (
            <div className="text-[10px] uppercase tracking-[0.28em] text-white/42">{eyebrow}</div>
          ) : null}
          <div className="mt-1 text-sm font-semibold tracking-tight text-white/92">{title}</div>
          <p className={`mt-2 text-[11px] leading-6 ${style.text}`}>{detail}</p>
          {meta ? <div className="mt-2 text-[9px] uppercase tracking-[0.18em] text-white/34">{meta}</div> : null}
        </div>
      </div>

      {actionLabel || secondaryActionLabel ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {actionLabel && onAction ? (
            <button
              type="button"
              onClick={onAction}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] text-white/78 transition hover:bg-white/10"
            >
              {actionLabel}
              <ArrowRight size={12} />
            </button>
          ) : null}
          {secondaryActionLabel && onSecondaryAction ? (
            <button
              type="button"
              onClick={onSecondaryAction}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] text-white/70 transition hover:bg-white/10"
            >
              {secondaryActionLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
