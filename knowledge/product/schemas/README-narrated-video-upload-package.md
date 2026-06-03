# Narrated Video Upload Package

`narrated-video-upload-package.schema.json` stores the staged output Kyberion uses before YouTube upload or public release.

It is separate from:

- `narrated-video-preference-profile`
- `narrated-video-publish-plan`
- `narrated-video-brief`
- `video-composition-adf`

Use it when the video is rendered and the next step is upload preparation rather than content generation.

The package captures:

- the publish plan reference
- target upload page
- title, description, visibility, and approval boundary
- artifact references
- checklist items for manual or browser-driven upload

This package does not mean the video is public. It is the staging artifact that keeps upload preparation explicit and reviewable.
