import { Button, Callout, Skeleton } from '@agent/shared-ui';
import { buildUserFacingError } from '../lib/user-facing-error';

export function MissionIntelligenceStatusGate({ context }: { context: Record<string, unknown> }) {
  const { error, locale, refreshData, mounted, data, mt } = context as {
    error?: unknown;
    locale?: string;
    missionIntelligenceEyebrow?: string;
    refreshData: () => Promise<void>;
    mounted: boolean;
    data?: unknown;
    mt: (key: string, fallback: string) => string;
  };
  if (error) {
    const safeError = buildUserFacingError(error, { locale, surface: 'chronos' });
    return (
      <Callout
        tone="danger"
        title={safeError.title}
        body={`${safeError.body} ${safeError.nextAction}`}
      >
        {safeError.traceLine ? (
          <p className="kb-text kb-text--mono">{safeError.traceLine}</p>
        ) : null}
        <div className="kb-callout__action">
          <Button
            label={mt('chronos_mi_retry', 'Retry')}
            onClick={() => {
              void refreshData();
            }}
          />
        </div>
      </Callout>
    );
  }

  if (!mounted || !data) {
    return (
      <Skeleton
        shape="card"
        lines={4}
        label={mt('chronos_mission_loading', 'Loading mission intelligence...')}
      />
    );
  }
  return null;
}
