# Procedure: Create Manual, Design Spec, And Video From Source Code

## 1. Goal

Analyze source code and produce:

- a manual document
- a design specification document
- a narrated video manual

The key rule is that all three artifacts must come from the same analysis brief.

## 2. Dependencies

- **Actuator**: `Code-Actuator`
- **Actuator**: `Media-Actuator`
- **Actuator**: `video-composition-actuator`
- **Actuator**: `voice-actuator`
- **Schemas**:
  - [`document-brief.schema.json`](/Users/famao/kyberion/knowledge/product/schemas/document-brief.schema.json)
  - [`video-content-brief.schema.json`](/Users/famao/kyberion/knowledge/product/schemas/video-content-brief.schema.json)
  - [`narrated-video-brief.schema.json`](/Users/famao/kyberion/knowledge/product/schemas/narrated-video-brief.schema.json)

## 3. Principle

Separate the work into:

- source capture
- code-analysis brief
- manual document
- design specification
- narrated video manual

The source code is not the document.
The code-analysis brief is the contract that bridges source surfaces to artifacts.

## 4. Step-by-Step Instructions

1. Inspect the source surfaces with `Code-Actuator`.
   - capture the file lists that matter
   - capture the key files that define the execution boundary
2. Write a `document-brief` for the manual.
   - use a report or runbook profile when the goal is operator guidance
3. Compile the manual through the canonical route:
   - `document_outline_from_brief`
   - `brief_to_design_protocol`
   - `generate_document`
4. Write a second `document-brief` for the design spec.
   - use a detailed-design profile when the goal is structural explanation
5. Compile the design spec through the same canonical route.
6. Convert the same analysis into a `video-content-brief`.
   - set `presentation_mode: howto`
   - use a `docs-demo` style content type when the video should explain the process
7. Generate narration audio.
8. Render the narrated video through `create_narrated_video_from_content_brief`.
9. Verify the manual, the design spec, the narration, and the final video artifact.

## 5. Recommended Artifact Set

- code analysis notes
- manual docx
- design spec docx
- narration audio
- narrated mp4

## 6. Expected Outcome

The user gets a source-backed explanation of:

- what code surfaces were analyzed
- what the code does
- how the documentation was generated
- how the video manual was produced
- how to reuse the same flow for the next codebase or subsystem
