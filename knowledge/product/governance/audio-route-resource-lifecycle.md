---
title: Audio Route Resource Lifecycle and Configuration Abstraction
kind: governance
scope: repository
authority: reference
phase: [alignment, execution, review]
tags:
  [
    audio,
    voice,
    coreaudio,
    blackhole,
    pulseaudio,
    lifecycle,
    cleanup,
    resources,
    abstraction,
    configuration,
  ]
owner: ecosystem_architect
status: active
last_updated: 2026-09-14
---

# Audio Route Resource Lifecycle and Configuration Abstraction

## Purpose

Audio and voice features cross process, operating-system, and device
boundaries. A route can therefore remain active after the initiating feature
has failed or returned unless initialization and shutdown are treated as one
resource lifecycle. This guide records the implementation rules learned from
an audio loopback incident in which a failed test left microphone monitoring
active through BlackHole and CoreAudio.

## Lifecycle rules

### Treat initialization as a transaction

Every acquired resource must have a cleanup action before the next resource is
acquired. If a later step fails, roll back all earlier steps in reverse order.
Typical resources include:

- device leases and route claims;
- PulseAudio modules or CoreAudio helper processes;
- ffmpeg, ffplay, or other capture/playback children;
- temporary artifacts and sidecar files;
- temporary changes to system defaults.

Do not set an `opened` or `healthy` flag as a substitute for cleanup. A helper
may already exist when startup negotiation, readiness, or format validation
fails.

### Make shutdown idempotent and failure-tolerant

`close()` must be safe to call more than once. Cleanup that must happen even
when another cleanup step fails belongs in `finally` (or an equivalent
resource-scope guard). Preserve the first meaningful error for the caller,
but still release processes, leases, queues, modules, and internal references.

At minimum, shutdown should:

1. stop accepting new audio;
2. close or drain the output path when safe;
3. terminate capture/playback children and their managed registrations;
4. release device leases and unload created modules in reverse order;
5. close queues and reset process/resource references;
6. report a closed health state.

An exception from `stdin.end()`, a helper wait, or a lease release must not
prevent the remaining cleanup steps.

### Do not rely only on language-level deferred cleanup

Swift `defer`, JavaScript `finally`, and similar constructs cover normal
returns and catchable errors. They do not run after `SIGKILL`, a host crash, or
an abrupt parent-process termination. Code that changes a system-wide default
device must either avoid the mutation, use a supervised recovery mechanism, or
make the residual state detectable and repairable on the next startup.

Prefer UID-selected CoreAudio output helpers over temporarily changing the
macOS default output. If a compatibility fallback must change the default,
record the previous device and expose an explicit recovery path.

## Configuration and abstraction rules

Do not hard-code operational parameters at call sites. Device names, UIDs,
sample rates, channel counts, timeouts, volume levels, executable paths,
PulseAudio module names, and cleanup policies must be supplied through typed
options, capability descriptors, registries, or centrally defined defaults.

The abstraction boundary should look like this:

- callers request an audio capability and a typed format, not a platform
  command line;
- adapters translate the capability into CoreAudio, PulseAudio, or another
  provider protocol;
- provider-specific identifiers and defaults live in configuration or
  registry data;
- tests inject devices, commands, timeouts, and failure behavior rather than
  depending on a real microphone, speaker, or installed binary.

Centralized defaults are acceptable when they are named, documented, and
overrideable. A literal is not a configuration abstraction merely because it
is declared in a local function.

## Verification requirements

Lifecycle tests should inject failures at each acquisition boundary and assert
all previously acquired resources are released. Include at least:

- output-helper startup failure after capture starts;
- failure after one of several device leases or modules is acquired;
- shutdown failure in the first cleanup operation;
- early consumer cancellation of an input stream;
- child-process timeout or unexpected exit;
- repeated `close()` calls;
- a compatibility route that changes a system default.

Use health/state assertions as well as spy assertions: no child process or
managed resource should remain, leases should be released, queues should be
closed, and the route should report `closed`.

## Incident signal

A repeating tone or microphone signal that continues after browsers and the
input device are closed is evidence of an active route, not necessarily an
audio file still playing. Inspect CoreAudio/BlackHole routing and managed
children first. Starting unrelated playback can mask the symptom by causing
CoreAudio to rebuild the route; that is not proof that the original lifecycle
was clean.
