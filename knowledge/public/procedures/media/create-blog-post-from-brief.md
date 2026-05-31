# Procedure: Create Blog Post From Brief

## 1. Goal

Execute a governed blog-authoring flow that:

- captures a blog post intent as a brief
- derives an article outline from that brief
- writes a publishable markdown draft
- keeps publish preparation separate from drafting

This procedure is for long-form text content where the article structure should be driven by the brief rather than by a one-off prompt.

## 2. Dependencies

- **Actuator**: `wisdom-actuator`
- **Actuator**: `code-actuator` or `system-actuator`
- **Playbook**: [`blog-authoring-playbook.md`](/Users/famao/kyberion/knowledge/public/orchestration/blog-authoring-playbook.md)

## 3. Contract Shape

Recommended flow:

1. `blog brief`
2. `article outline`
3. `draft`
4. `publish preview`

The article brief should at minimum define:

- topic
- audience
- angle
- desired takeaway
- tone
- constraints
- source requirements

The outline should then turn that brief into section order and section intent.

## 4. Execution

Suggested pipeline pattern:

1. Use `wisdom:synthesize` to produce a structured blog brief.
2. Use `wisdom:synthesize` again to derive the outline from that brief.
3. Use `wisdom:synthesize` a third time to draft the article from the brief and outline.
4. Use `code:write_artifact` or `system:write_file` to persist the markdown draft.

Example run:

```bash
pnpm pipeline --input pipelines/blog-article-from-brief.json
```

If you want a rendered preview, add a document-generation step after the draft and map the same brief into a document artifact.

## 5. Expected Output

- blog brief artifact
- article outline artifact
- markdown draft artifact
- optional publish preview artifact

## 6. Design Rule

Treat blog writing as a content-design problem, not as an unstructured prompt.
The brief decides the message, the outline decides the structure, and the draft preserves the publishable voice.
