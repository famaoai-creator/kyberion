---
title: Spectrum TS Message Handling Absorption Assessment
category: Architecture
tags: [messaging, surfaces, channel, abstraction, spectrum-ts]
importance: 8
author: Ecosystem Architect
last_updated: 2026-04-23
---

# Spectrum TS Message Handling Absorption Assessment

## Executive Verdict

Yes.

`spectrum-ts` contains a reusable abstraction pattern that Kyberion should absorb.
The main value is not the provider list itself.
The value is the user-facing message handling model:

- inbound events become normalized `message` objects
- response authority is attached to `space` and `message` methods
- provider differences are pushed behind a typed platform definition

That is directly relevant to Kyberion.

Kyberion already has strong governance, routing, and execution boundaries.
What it still lacks is a compact, first-class `surface message interaction model` that hides per-channel reply mechanics from higher-level work loops.

## Source Reviewed

Cloned from:

- `https://github.com/photon-hq/spectrum-ts`

Reviewed files:

- `packages/spectrum-ts/src/spectrum.ts`
- `packages/spectrum-ts/src/platform/define.ts`
- `packages/spectrum-ts/src/platform/types.ts`
- `packages/spectrum-ts/src/platform/build.ts`
- `packages/spectrum-ts/src/types/message.ts`
- `packages/spectrum-ts/src/types/space.ts`
- `packages/spectrum-ts/src/providers/terminal/index.ts`
- `examples/basic/index.ts`
- `examples/edit-echo/index.ts`

## What Is Good

## 1. `Space` As The Reply Authority

The cleanest idea in `spectrum-ts` is that user-facing reply behavior is attached to `space`.

Examples:

- `space.send(...)`
- `space.responding(...)`
- `space.startTyping()`
- `space.stopTyping()`

This is strong because:

- the caller does not need to know transport details
- reply behavior is contextual to the current conversation container
- typing and response lifecycle become standardized

Kyberion parallel:

- today, surface handling is spread across `channel-surface`, routing rules, and surface-specific artifact handling
- there is no equally compact `conversation-space` object that a higher layer can use uniformly

Absorption value:

- define one Kyberion `SurfaceSpace` abstraction as the governed response authority for a user-facing thread/session/channel context

## 2. `Message` As An Actionable Interaction Object

`spectrum-ts` turns inbound messages into normalized objects with methods:

- `message.reply(...)`
- `message.react(...)`

Outbound messages get:

- `edit(...)`

This matters because:

- message handling code stays close to user intent
- platform-specific reply IDs, reaction APIs, and edit constraints disappear from application code
- capability differences are still explicit

Kyberion parallel:

- current surface handling often operates on raw routing inputs plus separate helper functions
- this keeps surface code more procedural than object-oriented

Absorption value:

- define a governed `SurfaceMessage` object for Slack, Chronos, Presence voice, and future channels
- attach allowed surface actions directly to that object

## 3. Provider Definition Separates Events From Actions

`definePlatform(...)` in `spectrum-ts` is structurally good because it forces every provider to declare:

- lifecycle
- event producers
- action handlers
- space resolution
- user resolution
- optional message schema

That gives a stable adapter boundary.

Kyberion already has similar ideas distributed across:

- surface policy
- service binding
- channel surface routing
- actuator/runtime layers

But the shape is not as compact for user-facing messaging.

Absorption value:

- introduce a single `surface provider contract` that requires:
  - inbound event stream
  - space resolution
  - delivery actions
  - optional interaction affordances like reply/edit/react/typing
  - schema validation for provider-specific fields

## 4. Message Extras Are Parsed, But Core Fields Stay Stable

`spectrum-ts` keeps a stable core:

- `id`
- `content`
- `sender`
- `space`
- `timestamp`

Then provider-specific extras are parsed via optional schema.

This is the right balance:

- shared user-facing code uses the stable core
- platform-specific enrichments remain available without polluting the base model

Kyberion parallel:

- surface artifacts today are rich but channel-specific
- shared logic often has to care about Slack thread IDs, receiver routing, async request records, and mission proposals too early

Absorption value:

- define a minimal shared `SurfaceMessageCore`
- carry provider extras in a typed extension bag

## 5. Stream-First Intake Model

`spectrum-ts` models inbound messages as async iterables and merges provider streams.

This is useful because:

- intake is uniform whether the provider is terminal, iMessage, or WhatsApp
- higher-level loops consume one stream instead of one provider API per surface

Kyberion parallel:

- surfaces are normalized, but not yet exposed as one canonical `incoming message stream`
- Slack, Presence, Chronos, and async requests still feel like different handling modes

Absorption value:

- add one `surface ingress stream` abstraction above channel-specific listeners
- keep durable mission execution separate, but unify intake

## 6. Unsupported Capability Is Explicit

In `spectrum-ts`, unsupported actions fail as `UnsupportedError` and are surfaced as platform limitations instead of silently disappearing.

This is especially good for user-facing channels.

Kyberion should absorb this directly.

Today, some surface behavior differences are handled structurally, but the user-facing action affordance model is not always explicit enough.

Absorption value:

- give every `SurfaceMessage` and `SurfaceSpace` an explicit capability surface
- unsupported actions should return a governed `not_supported` result, not an implicit no-op

## 7. `responding()` Is A Good Interaction Primitive

`space.responding(async () => ...)` is a small but important pattern.

It standardizes:

- start typing
- do the work
- stop typing even on failure

Kyberion should absorb this idea almost literally.

For Kyberion, that primitive should become richer:

- emit typing/thinking/speaking status
- bind to Presence and Slack surfaces
- write observability artifacts
- preserve approval and mission authority boundaries

## What Should Be Absorbed

## 1. `SurfaceSpace`

A single object representing the current user-facing interaction context.

Minimum methods:

- `send(content)`
- `replyTo(message, content)`
- `edit(message, content)` when supported
- `react(message, reaction)` when supported
- `responding(fn, status?)`
- `notify(...)`

Minimum properties:

- `surface`
- `channel`
- `thread_or_session`
- `correlation_id`
- `mission_id?`

## 2. `SurfaceMessage`

A normalized message object with stable fields:

- `id`
- `surface`
- `sender`
- `content`
- `timestamp`
- `space_ref`
- `extras`

Methods:

- `reply(...)`
- `react(...)`
- `ack(...)` where relevant

## 3. `SurfaceProviderDefinition`

One declarative adapter shape for user-facing channels:

- `events.messages`
- `actions.send`
- `actions.reply`
- `actions.edit`
- `actions.react`
- `actions.start_status`
- `actions.stop_status`
- `space.resolve`
- `participant.resolve`

This should sit between:

- channel transport/runtime
- Kyberion routing/governance

## 4. `Surface Capability Contract`

Every surface provider should declare:

- supports reply
- supports edit
- supports reaction
- supports typing/thinking
- supports streaming partials
- supports attachments

This would simplify user-facing behavior decisions.

## 5. `Surface Core + Extension` Model

Shared core fields should be stable.
Provider-specific metadata should remain scoped in validated extensions.

That keeps surface logic portable without flattening everything.

## What Should Not Be Absorbed Literally

- the exact SDK-first API shape
- direct application-style looping as the primary Kyberion control pattern
- the assumption that user-facing message handlers should directly own final execution logic
- flattening all channel events into one generic app layer without governance artifacts

Kyberion must preserve:

- surface vs nerve vs execution separation
- mission authority
- approval gates
- durable coordination artifacts

So the right target is:

- not `Spectrum inside Kyberion`
- but `Spectrum-style message interaction abstraction inside Kyberion surfaces`

## Recommended Kyberion Reinterpretation

## 1. New Layer: `surface-interaction-model`

Add a compact layer above `channel-surface`:

- `SurfaceProviderDefinition`
- `SurfaceSpace`
- `SurfaceMessage`
- `SurfaceActionCapability`

This layer should only manage user-facing interaction semantics.
It should not own mission execution.

## 2. Keep Current Governance Boundaries

The new abstraction should hand off to existing Kyberion systems for:

- mission issuance
- delegation
- approval
- task planning
- async request persistence

That means:

- `SurfaceMessage.reply()` should deliver through the surface
- not mutate mission state directly

## 3. Unify Slack / Chronos / Presence / Voice Input

All of these should compile into the same interaction model:

- Slack thread
- Chronos session
- Presence voice turn
- future email/webhook channels

The surface-specific runtime still differs.
The interaction model should not.

## 4. Add A `responding()` Equivalent

Kyberion should expose a helper like:

- `surfaceSpace.responding(async () => ...)`

Behavior:

- emit `thinking` or `typing`
- bind timing/status to the surface
- stop cleanly on completion or failure
- append observability events

## 5. Split Interaction Handling From Work Routing

The key discipline is:

- interaction abstraction handles user-facing message semantics
- routing/nerve handles delegation and mission decisions

This separation is what will keep Kyberion simple.

## Concrete Absorption Opportunities

## Priority 0

- add `SurfaceSpace` and `SurfaceMessage` core types
- add `responding()` helper
- move Slack/Presence reply mechanics behind those abstractions

## Priority 1

- define `SurfaceProviderDefinition`
- wrap existing Slack, Chronos, and Presence ingress paths with provider adapters
- expose one normalized message stream

## Priority 2

- add explicit surface capability contract
- support edit/react/reply affordance checks centrally
- attach typed provider extras instead of ad hoc channel-specific fields

## Priority 3

- add custom event streams for non-message surface events:
  - typing
  - read receipt
  - presence signal
  - recording state

## Implementation Guidance

The most effective first move is not to rewrite `channel-surface`.

It is to add a narrow compatibility layer:

1. define `SurfaceMessageCore` and `SurfaceSpaceCore`
2. add Slack adapter that maps existing Slack artifact flow into these objects
3. add Presence adapter for voice/text ingress
4. gradually move higher-level user-facing logic to those abstractions

That gives Kyberion the conceptual clarity of `spectrum-ts` without sacrificing its stronger governance model.

### Current implementation status

- `libs/core/surface-interaction-model.ts` now exists as that compatibility layer
- `libs/core/surface-coordination-store.ts` now isolates:
  - outbox messages
  - surface notifications
  - async surface requests
- `libs/core/surface-ingress-contract.ts` now defines a normalized ingress envelope for:
  - Slack
  - Chronos
  - Presence
- `libs/core/surface-provider-manifest.ts` now exposes explicit provider manifests for:
  - default surface agent id
  - delivery mode
  - supported interaction capabilities
- `libs/core/surface-provider-policy.ts` now resolves provider-specific routing from governed knowledge:
  - `knowledge/public/governance/surface-provider-manifests.json`
  - `knowledge/public/schemas/surface-provider-manifests.schema.json`
- Slack-specific intent/execution/delegation rules also now live in `surface-provider-manifests.json`
- `runSurfaceConversation(...)` now prefers `surfaceText` / `surfaceMetadata` over reparsing Slack prompt text
- `surface-policy.json` is now effectively legacy compatibility data rather than the primary runtime source
- it provides:
  - `SurfaceProviderDefinition`
  - `SurfaceSpace`
  - `SurfaceMessage`
  - `SurfaceUnsupportedActionError`
- Slack has concrete wrappers through:
  - `createSlackSurfaceSpace(...)`
  - `createSlackSurfaceMessage(...)`
- Chronos and Presence also expose the same abstraction with explicit capability contracts
- active ingress paths now use the abstraction when assembling conversation input:
  - `satellites/slack-bridge/src/index.ts`
  - `presence/displays/chronos-mirror-v2/src/app/api/agent/route.ts`
  - `satellites/voice-hub/server.ts`
- `runSurfaceMessageConversation(...)` now provides a message-first API above `runSurfaceConversation(...)`
- receiver routing is now provider-aware instead of being only one shared surface rule set
- `libs/core/surface-runtime-router.ts` now owns routing-only policy resolution
- `libs/core/surface-runtime-orchestrator.ts` now owns delegation execution and response synthesis
- `libs/core/surface-response-blocks.ts` now owns surface response block parsing
- `libs/core/surface-artifact-store.ts` now owns surface event emission and delivery/request artifact persistence
- `libs/core/surface-mission-proposals.ts` now owns mission proposal persistence and issuance
- `libs/core/slack-approval-ui.ts` now owns Slack approval card persistence and decision handling
- `libs/core/slack-onboarding.ts` now owns Slack onboarding state, prompts, and modal flows
- `channel-surface` remains the legacy routing entrypoint, so migration can continue incrementally instead of as a rewrite

## Bottom Line

The user's intuition is correct.

The most valuable concept in `spectrum-ts` for Kyberion is:

- not multi-platform messaging by itself
- but a clean abstraction for `user-facing message handling`

Kyberion should absorb:

- `Space` as reply authority
- `Message` as actionable interaction object
- provider-defined event/action boundaries
- capability-aware response semantics

If implemented carefully, this would make Kyberion surfaces simpler, more portable, and easier to evolve without weakening mission governance.
