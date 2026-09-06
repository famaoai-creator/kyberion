import { SurfaceStatusPanel } from './SurfaceStatusPanel';
import { Panel } from './MissionIntelligencePrimitives';
import { chronosSpeechLocale } from '../lib/ux-vocabulary';
import { messageToneClass, messageTypeLabel } from './MissionIntelligenceViewHelpers';

export function MissionIntelligenceAgentTrafficPanel(context: Record<string, any>) {
  const {
    mt,
    panelVisible,
    messageMissionFilter,
    setMessageMissionFilter,
    setSelectedMissionId,
    filteredMissions,
    filteredAgentMessages,
    missionThreadPanelRef,
    effectiveMissionId,
    missionPinStatusLabel,
    focusMissionCard,
    missionThread,
    filteredA2AHandoffs,
  } = context;

  return (
    <section className="grid gap-4">
      <Panel
        id="agent-traffic"
        visible={panelVisible('agent-traffic')}
        title={mt('chronos_live_agent_conversation', 'Agent Traffic')}
      >
        <div className="mb-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setMessageMissionFilter('all');
              setSelectedMissionId(null);
            }}
            className={`rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.18em] transition ${
              messageMissionFilter === 'all'
                ? 'kb-border-accent kb-surface-accent kb-text-accent'
                : 'kb-border-subtle kb-surface-raised/5 kb-text-muted hover:kb-surface-raised'
            }`}
          >
            {mt('chronos_all_missions', 'all missions')}
          </button>
          {filteredMissions.map((mission) => (
            <button
              key={mission.missionId}
              type="button"
              onClick={() => {
                setMessageMissionFilter(mission.missionId);
                setSelectedMissionId(mission.missionId);
              }}
              className={`rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.18em] transition ${
                messageMissionFilter === mission.missionId
                  ? 'kb-border-accent kb-surface-accent kb-text-accent'
                  : 'kb-border-subtle kb-surface-raised/5 kb-text-muted hover:kb-surface-raised'
              }`}
            >
              {mission.missionId}
            </button>
          ))}
        </div>
        <div className="space-y-3">
          {filteredAgentMessages.length === 0 ? (
            <div className="text-[11px] italic kb-status-warning">
              {mt(
                'chronos_no_mission_scoped_messages',
                'No mission-scoped agent messages observed yet.'
              )}
            </div>
          ) : (
            filteredAgentMessages.map((message, index) => (
              <div
                key={`${message.agentId}-${message.ts}-${index}`}
                className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <div
                    className={`rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.2em] ${messageToneClass(message.tone)}`}
                  >
                    {messageTypeLabel(message.type)}
                  </div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] kb-text-secondary">
                    {message.agentId}
                  </div>
                  {message.teamRole && (
                    <div className="rounded-full border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                      {message.teamRole}
                    </div>
                  )}
                  {message.missionId && (
                    <div className="text-[10px] kb-text-muted">{message.missionId}</div>
                  )}
                  <div className="ml-auto text-[9px] font-mono kb-text-muted">
                    {new Date(message.ts).toLocaleString(chronosSpeechLocale())}
                  </div>
                </div>
                <div className="mt-2 text-[11px] leading-6 kb-text-primary">{message.content}</div>
                <div className="mt-2 flex flex-wrap gap-3 text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                  <span>
                    {mt('chronos_owner', 'owner')}: {message.ownerType}/{message.ownerId}
                  </span>
                  {message.channel && (
                    <span>
                      {mt('chronos_channel', 'channel')}: {message.channel}
                    </span>
                  )}
                  {message.thread && (
                    <span>
                      {mt('chronos_thread', 'thread')}: {message.thread}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </Panel>

      <div ref={missionThreadPanelRef}>
        <Panel
          id="selected-mission-thread"
          visible={panelVisible('selected-mission-thread')}
          title={mt('chronos_selected_mission_thread', 'Selected Mission Thread')}
        >
          <div className="mb-3 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.18em] kb-text-muted">
            <span>
              {effectiveMissionId
                ? `${mt('chronos_selected_mission_label', 'Selected mission')} · ${effectiveMissionId}`
                : mt(
                    'chronos_select_mission_to_inspect_thread',
                    'Select a mission to inspect its related messages.'
                  )}
            </span>
            <span className="rounded-full border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[9px] tracking-[0.16em] kb-text-muted">
              {missionPinStatusLabel}
            </span>
            {effectiveMissionId ? (
              <button
                type="button"
                onClick={() => focusMissionCard(effectiveMissionId)}
                className="rounded-full border kb-border-accent kb-surface-accent px-2 py-1 text-[9px] tracking-[0.16em] kb-text-accent transition hover:kb-surface-accent"
              >
                <span className="inline-flex items-center gap-2">
                  <span>Card</span>
                  <span className="rounded-full border kb-border-accent kb-surface-accent px-1.5 py-0.5 text-[8px] tracking-[0.18em] kb-text-accent">
                    C
                  </span>
                </span>
              </button>
            ) : null}
          </div>
          <div className="space-y-3">
            {!effectiveMissionId || missionThread.length === 0 ? (
              <SurfaceStatusPanel
                eyebrow={mt('chronos_selected_mission_thread', 'Mission messages')}
                title={
                  effectiveMissionId
                    ? mt('chronos_no_mission_thread', 'This mission has no messages yet')
                    : mt('chronos_select_mission_to_inspect_thread', 'Select a mission')
                }
                detail={
                  effectiveMissionId
                    ? mt(
                        'chronos_no_mission_thread_hint',
                        'Execution records and handoffs will appear here when they are added.'
                      )
                    : mt(
                        'chronos_select_mission_to_inspect_thread',
                        'Select a mission to inspect its related messages.'
                      )
                }
                tone="info"
              />
            ) : (
              missionThread.map((entry, index) => (
                <div
                  key={`${entry.type}-${entry.agentId}-${entry.ts}-${index}`}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <div
                      className={`rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.2em] ${messageToneClass(entry.tone)}`}
                    >
                      {messageTypeLabel(entry.type)}
                    </div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] kb-text-secondary">
                      {entry.label}
                    </div>
                    {entry.teamRole && (
                      <div className="rounded-full border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                        {entry.teamRole}
                      </div>
                    )}
                    <div className="ml-auto text-[9px] font-mono kb-text-muted">
                      {new Date(entry.ts).toLocaleString(chronosSpeechLocale())}
                    </div>
                  </div>
                  <div className="mt-2 text-[11px] leading-6 kb-text-primary">{entry.content}</div>
                  <div className="mt-2 flex flex-wrap gap-3 text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                    {entry.channel && (
                      <span>
                        {mt('chronos_channel', 'channel')}: {entry.channel}
                      </span>
                    )}
                    {entry.thread && (
                      <span>
                        {mt('chronos_thread', 'thread')}: {entry.thread}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>
      </div>

      <Panel
        id="a2a-handoff-trail"
        visible={panelVisible('a2a-handoff-trail')}
        title={mt('chronos_a2a_handoff_trail', 'A2A Handoff Trail')}
      >
        <div className="space-y-3">
          {filteredA2AHandoffs.length === 0 ? (
            <SurfaceStatusPanel
              eyebrow="A2A handoff trail"
              title="No A2A handoffs observed for the current mission filter"
              detail="Handoffs appear here once the selected mission exchanges prompts, tasks, or acknowledgements."
              tone="neutral"
            />
          ) : (
            filteredA2AHandoffs.map((handoff, index) => (
              <div
                key={`${handoff.sender}-${handoff.receiver}-${handoff.ts}-${index}`}
                className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <div className="rounded-full border kb-border-accent kb-surface-accent px-2 py-1 text-[9px] uppercase tracking-[0.2em] kb-text-accent">
                    a2a handoff
                  </div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] kb-text-secondary">
                    {handoff.sender} → {handoff.receiver}
                  </div>
                  {handoff.teamRole && (
                    <div className="rounded-full border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                      {handoff.teamRole}
                    </div>
                  )}
                  <div className="ml-auto text-[9px] font-mono kb-text-muted">
                    {new Date(handoff.ts).toLocaleString(chronosSpeechLocale())}
                  </div>
                </div>
                <div className="mt-2 text-[10px] uppercase tracking-[0.16em] kb-text-muted">
                  {mt('chronos_mission', 'mission')}: {handoff.missionId}
                  {handoff.intent ? ` · ${mt('chronos_intent', 'intent')}: ${handoff.intent}` : ''}
                  {handoff.performative ? ` · ${handoff.performative}` : ''}
                </div>
                {handoff.promptExcerpt && (
                  <div className="mt-2 text-[11px] leading-6 kb-text-primary">
                    {handoff.promptExcerpt}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-3 text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                  {handoff.channel && (
                    <span>
                      {mt('chronos_channel', 'channel')}: {handoff.channel}
                    </span>
                  )}
                  {handoff.thread && (
                    <span>
                      {mt('chronos_thread', 'thread')}: {handoff.thread}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </Panel>
    </section>
  );
}
