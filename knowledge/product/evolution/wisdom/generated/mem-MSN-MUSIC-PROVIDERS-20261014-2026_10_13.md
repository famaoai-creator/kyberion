---
record_id: mem-MSN-MUSIC-PROVIDERS-20261014-2026_10_13
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-MUSIC-PROVIDERS-20261014-2026_10_13
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-13T16:34:02.751Z
source_branch: feat/music-mlx-providers-20261014
source_commit: c9e2e36a3f40a632c902fd175bebd1298a9aadc6
---

# MLX local music providers: MusicGen variants and ChatMusician composition

generate_music gained musicgen_audiogen (mono/stereo/melody variants with first-run weight auto-provisioning) and chatmusician_mlx (ABC composition rendered to WAV), plus a vocals/instrumental request split and a compose selection purpose.

## Hint Scope

mission

## Trigger Phrases

- Local CLI music backends: media-generation.musicgen_audiogen (KYBERION_MUSAUDIOGEN__, variant via model mapping, weights auto-fetched once from pre-converted HF repos into ~/.mlx-audiogen/models) and media-generation.chatmusician_mlx (KYBERION_CHATMUSICIAN__, mlx-lm ABC output rendered via abc2midi -o and position-sensitive fluidsynth flags, SoundFont required). All local providers are instrumental-only; vocals:true fails closed with a SongGeneration-MLX future pointer. Purpose compose ranks composition ability via the composition trait. Integration pitfalls recorded in test-report: mlx-audiogen requires --weights-dir, huggingface-cli was renamed to hf, registry shared headers compare strictly including key order.

## Recommended References

- active/missions/public/MSN-MUSIC-PROVIDERS-20261014/evidence/distillation.md
- active/missions/public/MSN-MUSIC-PROVIDERS-20261014/evidence/test-report.md

## Evidence

- active/missions/public/MSN-MUSIC-PROVIDERS-20261014/evidence/distillation.md
- active/missions/public/MSN-MUSIC-PROVIDERS-20261014/evidence/test-report.md

## Artifacts
