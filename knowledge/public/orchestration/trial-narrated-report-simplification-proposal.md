# Trial Narrated Report Simplification Proposal

**Date**: 2026-05-04  
**Target**: `pipelines/trial-narrated-report.json`

## 1. Goal

Reduce mechanical shell work and make the pipeline read as a narration-generation contract rather than a shell script.

## 2. Current Pain Points

- long `system:shell` preflight command
- heredoc-based JSON construction for voice and video actions
- explicit artifact verification steps repeated inline
- generation and validation details mixed into the same pipeline

## 3. Proposed Target Shape

### 3.1 Before

Current shape:

1. runtime preflight
2. write voice action JSON
3. write video action JSON
4. write render policy JSON
5. run voice generation
6. verify audio
7. run video generation
8. verify outputs
9. log final status

### 3.2 After

Proposed shape:

1. preflight prerequisites
2. materialize action bundle
3. run audio generation
4. run video generation
5. validate artifacts
6. log final status

## 4. Concrete Refactoring Moves

### 4.1 Shorten preflight

Replace the long shell chain with a smaller explicit check set.

Keep only the checks that directly gate the generation flow:

- `ffmpeg`
- `ffprobe`
- platform voice tool
- built actuator artifacts

If helper ops exist later, these should move behind them:

- binary assertion helper
- artifact assertion helper

### 4.2 Centralize action bundle creation

The two heredocs and the render policy file are the biggest readability issue.

Recommended direction:

- create one structured action bundle object
- derive the voice and video payloads from that bundle
- write them in a single preparation step

This keeps the pipeline focused on intent:

- narrated summary
- audio render
- video render

### 4.3 Collapse verification into one artifact check

The audio and video checks can be consolidated into a single validation step that reports:

- audio exists
- video exists
- video bundle exists
- audio stream is muxed

## 5. Suggested Step Boundary

Recommended final step sequence:

1. `preflight_runtime`
2. `prepare_render_bundle`
3. `generate_audio`
4. `generate_video`
5. `validate_outputs`
6. `final_log`

## 6. Success Criteria

- the pipeline is shorter
- the shell commands are easier to read
- the generation intent is visible without scrolling through implementation details
- output validation is still explicit

## 7. Implementation Order

1. narrow the preflight command
2. combine the heredoc setup into one preparation step
3. keep the output validation explicit but shorter

---
*Proposal distilled on 2026-05-04*
