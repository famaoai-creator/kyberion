# Narrated Video Preference Profile

`narrated-video-preference-profile.schema.json` stores reusable preferences for narrated product videos, tutorial clips, and YouTube publication gating.

It separates:

- brief questions for the current video request
- visual theme selection for the current purpose
- publish policy for whether Kyberion may upload, keep private, or stop at a prepared package
- asset policy for source and licensing constraints

Use it when the request is closer to "make a video and help me publish it" than to "answer a question".

The profile does not define the video itself. The content still belongs in `narrated-video-brief`.
The concrete upload package belongs in `narrated-video-publish-plan`.

The publish policy is intentionally conservative:

- draft or unlisted upload can be prepared automatically when allowed
- public release should require explicit human approval
- thumbnail, description, and caption requirements should be checked before upload

This keeps video work aligned with the same `brief-first` pattern used for presentation and booking tasks, while keeping the final publish boundary visible.
