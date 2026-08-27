import { SurfaceStatusPanel } from './SurfaceStatusPanel';
import { buildUserFacingError } from '../lib/user-facing-error';

export function MissionIntelligenceStatusGate(context: Record<string, unknown>) {
  const { error, locale, missionIntelligenceEyebrow, refreshData, mounted, data, mt } = context as {
    error?: unknown;
    locale?: string;
    missionIntelligenceEyebrow: string;
    refreshData: () => Promise<void>;
    mounted: boolean;
    data?: unknown;
    mt: (key: string, fallback: string) => string;
  };
  if (error) {
    const safeError = buildUserFacingError(error, { locale, surface: 'chronos' });
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="w-full max-w-xl">
          <SurfaceStatusPanel
            eyebrow={missionIntelligenceEyebrow}
            title={safeError.title}
            detail={`${safeError.body} ${safeError.nextAction}`}
            tone="error"
            meta={safeError.traceLine}
            actionLabel="Retry"
            onAction={() => {
              void refreshData();
            }}
          />
        </div>
      </div>
    );
  }

  if (!mounted) {
    return (
      <SurfaceStatusPanel
        eyebrow={missionIntelligenceEyebrow}
        title="Loading mission intelligence"
        detail="Chronos is fetching missions, runtime state, and the latest governance signals."
        tone="neutral"
      />
    );
  }

  if (!data) {
    return (
      <SurfaceStatusPanel
        eyebrow={missionIntelligenceEyebrow}
        title={mt('chronos_waiting_for_data', 'Waiting for data')}
        detail={mt('chronos_mission_loading', 'Loading mission intelligence...')}
        tone="neutral"
      />
    );
  }
  return null;
}
