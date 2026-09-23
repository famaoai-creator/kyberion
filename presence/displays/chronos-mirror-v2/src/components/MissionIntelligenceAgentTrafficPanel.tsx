import { Badge, Button, EmptyState, Tabs } from '@agent/shared-ui';
import { Panel } from './MissionIntelligencePrimitives';
import { messageToneStatus, messageTypeLabel } from './MissionIntelligenceViewHelpers';
import { FeedItem, FeedList, formatDateTime, metaLine } from './MissionIntelligenceBFeed';

export function MissionIntelligenceAgentTrafficPanel({
  context,
}: {
  context: Record<string, any>;
}) {
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

  const channelMeta = (entry: { channel?: string; thread?: string }) =>
    metaLine([
      entry.channel && `${mt('chronos_channel', 'channel')}: ${entry.channel}`,
      entry.thread && `${mt('chronos_thread', 'thread')}: ${entry.thread}`,
    ]);

  return (
    <section className="grid gap-4">
      <Panel
        id="agent-traffic"
        visible={panelVisible('agent-traffic')}
        title={mt('chronos_live_agent_conversation', 'Agent Traffic')}
      >
        <div className="chronos-subnav">
          <Tabs
            label={mt('chronos_mip_filter_by_mission', 'Filter by mission')}
            active={messageMissionFilter}
            items={[
              { id: 'all', label: mt('chronos_all_missions', 'all missions') },
              ...filteredMissions.map((mission: { missionId: string }) => ({
                id: mission.missionId,
                label: mission.missionId,
              })),
            ]}
            onSelect={(id) => {
              setMessageMissionFilter(id);
              setSelectedMissionId(id === 'all' ? null : id);
            }}
          />
        </div>
        {filteredAgentMessages.length === 0 ? (
          <p className="kb-text kb-text--muted">
            {mt(
              'chronos_no_mission_scoped_messages',
              'No mission-scoped agent messages observed yet.'
            )}
          </p>
        ) : (
          <FeedList variant="timeline">
            {filteredAgentMessages.map((message: any, index: number) => (
              <FeedItem
                key={`${message.agentId}-${message.ts}-${index}`}
                title={message.agentId}
                titleId={message.missionId}
                status={messageToneStatus(message.tone)}
                statusLabel={messageTypeLabel(message.type)}
                meta={metaLine([
                  formatDateTime(message.ts),
                  message.teamRole,
                  `${mt('chronos_owner', 'owner')}: ${message.ownerType}/${message.ownerId}`,
                  channelMeta(message),
                ])}
              >
                <p className="kb-text kb-text--body">{message.content}</p>
              </FeedItem>
            ))}
          </FeedList>
        )}
      </Panel>

      <div ref={missionThreadPanelRef}>
        <Panel
          id="selected-mission-thread"
          visible={panelVisible('selected-mission-thread')}
          title={mt('chronos_selected_mission_thread', 'Selected Mission Thread')}
          description={
            effectiveMissionId
              ? `${mt('chronos_selected_mission_label', 'Selected mission')} · ${effectiveMissionId}`
              : mt(
                  'chronos_select_mission_to_inspect_thread',
                  'Select a mission to inspect its related messages.'
                )
          }
          actions={
            <>
              <Badge label={missionPinStatusLabel} tone="neutral" />
              {effectiveMissionId ? (
                <Button
                  label={mt('chronos_mip_open_mission_card', 'Open mission card (C)')}
                  variant="ghost"
                  onClick={() => focusMissionCard(effectiveMissionId)}
                />
              ) : null}
            </>
          }
        >
          {!effectiveMissionId || missionThread.length === 0 ? (
            <EmptyState
              title={
                effectiveMissionId
                  ? mt('chronos_no_mission_thread', 'This mission has no messages yet')
                  : mt('chronos_select_mission_to_inspect_thread', 'Select a mission')
              }
              body={
                effectiveMissionId
                  ? mt(
                      'chronos_no_mission_thread_hint',
                      'Execution records and handoffs will appear here when they are added.'
                    )
                  : undefined
              }
            />
          ) : (
            <FeedList variant="timeline">
              {missionThread.map((entry: any, index: number) => (
                <FeedItem
                  key={`${entry.type}-${entry.agentId}-${entry.ts}-${index}`}
                  title={entry.label}
                  status={messageToneStatus(entry.tone)}
                  statusLabel={messageTypeLabel(entry.type)}
                  meta={metaLine([formatDateTime(entry.ts), entry.teamRole, channelMeta(entry)])}
                >
                  <p className="kb-text kb-text--body">{entry.content}</p>
                </FeedItem>
              ))}
            </FeedList>
          )}
        </Panel>
      </div>

      <Panel
        id="a2a-handoff-trail"
        visible={panelVisible('a2a-handoff-trail')}
        title={mt('chronos_a2a_handoff_trail', 'A2A Handoff Trail')}
      >
        {filteredA2AHandoffs.length === 0 ? (
          <EmptyState
            title={mt(
              'chronos_mip_no_handoffs',
              'No A2A handoffs observed for the current mission filter'
            )}
            body={mt(
              'chronos_mip_no_handoffs_hint',
              'Handoffs appear here once the selected mission exchanges prompts, tasks, or acknowledgements.'
            )}
          />
        ) : (
          <FeedList variant="timeline">
            {filteredA2AHandoffs.map((handoff: any, index: number) => (
              <FeedItem
                key={`${handoff.sender}-${handoff.receiver}-${handoff.ts}-${index}`}
                title={`${handoff.sender} → ${handoff.receiver}`}
                titleId={handoff.missionId}
                status="active"
                statusLabel={messageTypeLabel('handoff')}
                meta={metaLine([
                  formatDateTime(handoff.ts),
                  handoff.teamRole,
                  handoff.intent && `${mt('chronos_intent', 'intent')}: ${handoff.intent}`,
                  handoff.performative,
                  channelMeta(handoff),
                ])}
              >
                {handoff.promptExcerpt ? (
                  <p className="kb-text kb-text--body">{handoff.promptExcerpt}</p>
                ) : null}
              </FeedItem>
            ))}
          </FeedList>
        )}
      </Panel>
    </section>
  );
}
