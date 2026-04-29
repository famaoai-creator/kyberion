# Publish a Narrated Video to YouTube

Use this procedure after the video has already been rendered and approved for upload preparation.

## Inputs

- `narrated-video-publish-plan`
- `narrated-video-upload-package`
- final rendered video artifact
- thumbnail and caption artifacts

## Staging

1. Prepare the upload package with the YouTube service preset.
2. Save the staged package under `active/shared/runtime/youtube/upload-packages/`.
3. Review the package for title, description, visibility, and approval boundary.

## Upload Boundary

- If the package is `draft_only`, stop after staging.
- If the package is `unlisted`, the browser or operator may proceed with upload, but should not publish publicly without approval.
- If the package is `public`, require explicit human approval before release.

## Browser Upload

When browser upload is used, open YouTube Studio upload and copy the staged package fields into the upload form.

Checklist:

- video file
- title
- description
- thumbnail
- captions
- tags
- visibility

Stop at the publish boundary unless approval is present.

## Notes

Kyberion currently stages the package and keeps the public release boundary explicit.
Actual browser upload automation can be added on top of this package when the credentials and policy are ready.
