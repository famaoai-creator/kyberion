---
title: Realtime Media Session, Meeting Intelligence, and Avatar Model
category: Architecture
tags: [architecture, realtime, voice, meeting, diarization, viseme, avatar, media-session]
importance: 10
author: Ecosystem Architect
last_updated: 2026-09-16
kind: architecture
scope: repository
authority: reference
phase: [alignment, execution, review]
role_affinity: [ecosystem_architect, solution_architect, implementer, reviewer]
applies_to: [voice, meetings, realtime, avatars, presence, media]
owner: ecosystem_architect
status: active
---

# Realtime Media Session, Meeting Intelligence, and Avatar Model

## 1. Purpose

Kyberion needs one media-session foundation for four related but different
experiences:

1. `assistant`: a low-latency conversation with one user.
2. `meeting_observer`: multi-speaker capture, transcription, diarization, and
   meeting analysis.
3. `meeting_participant`: an agent that joins a meeting and may speak,
   facilitate, chat, or leave under explicit governance.
4. `avatar_presence`: audio, viseme, blendshape, expression, and gesture
   output for an avatar or presence surface.

These modes share media and identity data, but must not share assumptions. A
single user realtime model is not a multi-speaker diarization engine, and a
voice profile is not an avatar identity.

This document is the design contract for the reusable core implemented by
`libs/core/realtime-media-session.ts`. Existing meeting participation,
realtime voice, meeting intelligence, and presence code remains compatible
through adapters and projections.

## 2. Existing seams and boundaries

The repository already provides useful lower-level seams:

- `MeetingSession` exposes inbound/outbound audio and optional native captions
  in `libs/core/meeting-session-types.ts`.
- `MeetingParticipationCoordinator` composes a meeting driver, audio bus, STT,
  TTS, VAD, agent, consent, and audit in
  `libs/core/meeting-participation-coordinator.ts`.
- `realtime-voice-loop.ts` provides VAD-driven turn handling, streaming STT,
  sentence-level TTS, optional barge-in, transcript persistence, and metrics.
- `meeting-intelligence-ops.ts` extracts action items and records speaker
  provenance and fairness reports.
- `presence-surface.ts` provides status, expression, subtitle, transcript,
  and avatar surface state.
- `voice:render_talking_avatar` provides an offline volume-driven mouth
  fallback for raster talking-avatar video.

The missing common seam is a typed media event model that can fan out to
conversation, meeting intelligence, and avatar projections without forcing
them into one sequential pipeline.

## 3. Domain model

### 3.1 Session modes

```text
assistant          direct user/agent conversation
meeting_observer   listen and analyze; silent by default
meeting_participant join a meeting and optionally speak under consent
avatar_presence    render agent output and animation cues
```

`meeting_observer` is the safe default for multi-party meetings. Speaking is a
separate capability with its own consent and audit gate.

### 3.2 Participant identity

Speaker labels must not be treated as verified identity. The model separates:

- `speaker_id`: stable, session-local audio attribution such as `spk_0`.
- `person_ref`: verified roster/person reference, when available.
- `voice_profile_id`: voice used for synthesized output.
- `avatar_profile_id`: visual identity used for output.

```ts
interface MediaParticipant {
  participant_id: string;
  kind: 'human' | 'agent' | 'system';
  display_label?: string;
  person_ref?: string;
  voice_profile_id?: string;
  avatar_profile_id?: string;
}
```

Unverified diarization produces `speaker_id` only. It must not infer a
`person_ref` from a voice embedding or a display name.

### 3.3 Canonical media events

Runtime events are append-only and fan out to multiple consumers.

```text
session_started / session_ended
audio_frame
speech_started / speech_ended
speaker_attribution
transcript_delta / transcript_final
assistant_text_delta
audio_output_delta
animation_cue
tool_request / tool_result
turn_completed
error
```

Every event carries `session_id`, `event_id`, monotonic `at_ms`, optional wall
clock `emitted_at`, `participant_id` or `speaker_id` when applicable, source,
and confidence/provenance where the provider exposes it. Raw audio frames are
ephemeral by default; durable records use scoped artifact references.

The implementation exposes `MediaEvent`, `MediaSessionDescriptor`, and
`MediaEventBuffer` as a small provider-neutral contract. It does not perform
provider I/O or bypass Kyberion governance.

## 4. Audio and provider adapters

The provider boundary is a realtime session transport, not a text-only
reasoning backend:

```ts
interface RealtimeVoiceTransport {
  connect(config: RealtimeVoiceTransportConfig): Promise<RealtimeVoiceConnection>;
}

interface RealtimeVoiceConnection {
  capabilities: RealtimeVoiceCapabilities;
  sendAudio(chunk: AudioChunk): Promise<void>;
  sendText(text: string): Promise<void>;
  events(): AsyncIterable<MediaEvent>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}
```

Adapters include:

- OpenAI Realtime or Gemini Live for native speech-to-speech conversation.
- The current VAD → STT → reasoning → TTS loop as a local turn-based fallback.
- VibeVoice-ASR for long-form or meeting transcription and speaker/timestamp
  enrichment.
- Azure Voice Live for managed audio timestamp, viseme, blendshape, and
  WebRTC avatar output.
- NVIDIA Audio2Face or a local renderer for audio-driven 3D blendshape output.

Provider tool calls are events first. They must enter the governed tool broker
with the canonical WorkItem and scope before any side effect is executed.

## 5. Multi-speaker meeting processing

Meeting processing has two truth levels:

```text
live path:
  meeting audio/captions → tentative speaker_id → partial transcript
  → optional facilitation / alerts

post path:
  complete recording → authoritative diarization and timestamp reconciliation
  → roster/person binding → summary, action items, fairness, follow-up
```

The live path may use platform captions, per-track audio, or a streaming ASR
adapter. The post path may use VibeVoice-ASR or another governed diarization
adapter. If the provider does not guarantee live diarization, the live
speaker identity is explicitly marked tentative and the post path remains the
authoritative record.

The canonical transcript segment contains:

```text
segment_id, session_id, speaker_id, person_ref?, start_ms, end_ms,
text, words?, is_final, confidence, source, partial_state
```

The existing `speaker_label` field remains a compatibility projection. Action
item extraction consumes canonical segment references and continues to record
verbatim excerpts and line/offset provenance. Fairness analysis uses stable
session speaker IDs and reports unattributed items separately.

Raw meeting audio and participant-linked transcripts remain in the meeting's
tenant-confidential scope. External provider egress, retention, diarization,
voice cloning, and avatar animation require separate consent records.

## 6. Viseme and avatar output

Visemes are a timed animation track, not an expression string and not a
property of a single voice profile.

```text
AnimationCue:
  session_id
  target_avatar_id
  audio_track_id
  at_ms / duration_ms
  kind: viseme | blendshape | expression | gaze | gesture
  payload
  source: provider | phoneme_alignment | rms_fallback
  confidence?
```

The source priority is:

1. provider-native viseme or blendshape events;
2. phoneme/word alignment converted to Kyberion's canonical animation space;
3. the existing volume-driven mouth fallback.

Provider-specific identifiers remain in provenance. A normalization adapter
maps them to a stable canonical set, then a target adapter maps that set to
SVG expressions, Live2D parameters, VRM/ARKit blendshapes, or a remote avatar
video stream.

`PresenceTimelineAdf` remains appropriate for low-frequency state changes such
as `set_status`, `set_expression`, subtitles, and scene changes. High-rate
audio and animation events use the runtime media event stream and are never
encoded as one ADF event per frame.

For a meeting display, human participants default to speaker tiles, names, and
transcript. Only an AI participant is animated by default. A human likeness or
voice must not be synthesized or animated without explicit participant
consent.

## 7. Provider selection rationale

VibeVoice-ASR is a strong meeting-analysis candidate because its official
materials describe long-form transcription with Who/When/What structure and
speaker/timestamp output. Its realtime TTS model is an optional low-latency
single-output adapter, not the sole conversation foundation; the official
repository has changed the availability of the original multi-speaker TTS
code, so the dependency must be pinned and reviewed before production use.

Gemini Live and OpenAI Realtime are suitable for a natural user/agent
conversation because they provide persistent bidirectional audio sessions.
They do not replace the meeting diarization path.

Azure Voice Live is the preferred managed integration when viseme/blendshape
events and a WebRTC avatar are first-class requirements. A local 3D runtime
can instead consume the normalized animation track.

## 8. Governance invariants

The media session must enforce all of the following before activation:

- recording consent for microphone or meeting capture;
- participant disclosure and meeting-platform consent;
- external provider audio egress consent;
- voice profile/voice-clone consent;
- avatar likeness and animation consent;
- tenant and viewer scope resolved server-side;
- raw media retention and deletion policy;
- WorkItem-scoped, audited tool calls;
- fail-closed behavior for missing speaker attribution or partial capture.

No client-provided `tenant`, `tier`, `speaker`, or `avatar` value is an
authorization decision. These values can narrow an already authorized scope
but cannot expand it.

## 9. Implementation and acceptance plan

The first implementation slice adds the provider-neutral event and identity
contract, a bounded in-memory event buffer, transcript/animation normalizers,
and tests. Existing providers remain unchanged and are adapted incrementally.

Acceptance criteria:

1. One session model represents assistant, observer, participant, and avatar
   presence modes without conflating them.
2. Multiple consumers can observe the same session events without mutating
   mission-wide state.
3. Partial and tentative speaker attribution is explicit and never promoted to
   person identity automatically.
4. Viseme, blendshape, expression, and RMS fallback are distinct animation
   sources with preserved timing and provenance.
5. Existing meeting action-item and presence projections remain compatible.
6. Provider-native transports can be added without changing meeting
   analytics or avatar consumers.
7. Unit, type, build, governance, and runtime preflight checks pass; unavailable
   microphone/model/provider prerequisites are reported rather than hidden.

## 10. References

- [VibeVoice official repository](https://github.com/microsoft/VibeVoice)
- [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api/get-started-sdk)
- [Gemini Live transcription limitations](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe)
- [OpenAI Realtime API](https://platform.openai.com/docs/api-reference/realtime?lang=javascript)
- [Azure Voice Live API and visemes](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to)
- [NVIDIA Audio2Face-3D](https://docs.nvidia.com/ace/audio2face-3d-microservice/1.0/text/getting-started/overview.html)
