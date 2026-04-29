# Narrated Video Publish Plan

`narrated-video-publish-plan.schema.json` stores the publish-side contract for narrated video output.

It is separate from `narrated-video-brief` and from `video-composition-adf`.

Use it when the render is done and Kyberion needs to prepare the upload package, but should still stop before public release.

The plan captures:

- target channel or draft-only destination
- title and description
- visibility
- approval boundary
- video artifact reference
- thumbnail and caption references
- optional tags and schedule time

The publish plan is intentionally conservative:

- `draft_only` is for preparing assets without upload
- `unlisted` upload can be staged when the profile allows it
- `public` release should be gated by explicit approval

This keeps publication separate from generation, so the render pipeline and the release decision do not get conflated.
