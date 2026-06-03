# Code Documentation And Video Production Playbook

Use this playbook when the user asks to analyze source code and turn the result into manuals, design documents, or a narrated video manual.
It specializes the shared [Guided Coordination Protocol](knowledge/product/orchestration/guided-coordination-protocol.md) for code-to-documentation work.

## Kyberion Fit

Code documentation work should be treated as a governed coordination flow.
The value is not in copying source code into a document. The value is in capturing code surfaces, normalizing them into a brief, and then compiling that brief into reusable documents and a narrated video artifact.

Use Kyberion when the task has at least one of these properties:

1. It needs a manual, design spec, or runbook derived from source code.
2. It should produce both textual documentation and a narrated video walkthrough.
3. It depends on source analysis, reusable structure, or evidence-backed explanation.
4. It should keep manual generation, design generation, and video generation on the same brief.

## Brief And Output Separation

Keep three layers distinct inside the shared coordination flow:

1. Code analysis layer: which source surfaces were inspected and what the code is doing.
2. Documentation layer: how the analysis becomes a manual or design document.
3. Video layer: how the same analysis becomes a narrated walkthrough.

Do not let the video script redefine the code analysis, and do not let the manual invent renderer coordinates or presentation assets.
The shared brief should control the meaning, while the document and video compilers control the output shape.

## Preflight

Before drafting the manual or the video, decide which code surfaces matter and which outputs are needed.

1. Read the source surfaces that anchor the explanation.
2. Pick the document profile for the manual.
3. Pick the document profile for the design spec.
4. Pick the presentation mode for the narrated video, usually `howto`.
5. Ask only the questions that would materially change the output boundary or the audience.

Good fits for this preflight include actuator walkthroughs, repo onboarding manuals, architecture explanations, and implementation handoff packs.

## Workflow

1. Capture source surfaces: inspect the relevant source files and confirm the execution boundary.
2. Analysis brief: normalize the code observations into a code-analysis brief.
3. Manual draft: turn the analysis into a manual or runbook document.
4. Design draft: turn the same analysis into a design specification document.
5. Video brief: transform the analysis into a `video-content-brief`.
6. Video render: compile and render the narrated video package.
7. Review: identify reusable documentation or video patterns that should be promoted only after review.

## Publish Boundary

Treat render and publish as separate gates.

Safe defaults:

- allow document generation and video rendering to complete
- keep internal manual and design outputs in governed paths
- require approval before any external publish or distribution step

## Outputs

Minimum output:

1. Current assumptions and source surfaces analyzed.
2. Manual document summary.
3. Design document summary.
4. Narrated video summary and verification status.

Full output:

1. Code-analysis brief.
2. Manual artifact.
3. Design artifact.
4. Narrated video artifact.
5. Verification log and artifact paths.
6. Reuse candidates for future code-to-doc or code-to-video runs.
