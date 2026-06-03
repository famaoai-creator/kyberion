# Media Document Generation Boundary

Kyberion's document generation model is not "LLM writes files directly".

It is:

`intent -> governed brief -> knowledge-selected composition -> protocol compiler -> deterministic renderer`

This boundary is the core of Kyberion's media system.

## Layers

### 1. Intent / LLM Layer

The LLM may:

- interpret the sovereign's request
- normalize multilingual input into a canonical brief
- draft section goals, body text, bullets, callouts, and table content
- propose evidence phrasing or operator-facing summaries

The LLM must not:

- invent governed `sections` when a profile already defines them
- invent renderer coordinates
- invent low-level binary protocol structures
- override semantic or design-system rules owned by knowledge

In short:

- the LLM may draft content
- the LLM may not redefine structure owned by knowledge

### 2. Knowledge Layer

Knowledge is the source of truth for:

- `document_profile`
- `sections`
- `narrative_pattern_id`
- `layout_key`
- `media_kind`
- `semantic_type`
- `recommended_theme`
- `design_system_id`

If `profile.sections` exists, it wins.

`document_type` is fallback taxonomy only.

## 3. Protocol Compiler Layer

The protocol compiler is the abstraction boundary between semantic intent and physical output.

Its responsibilities are:

- resolve profile and sections from knowledge
- create the outline ADF
- map outline sections into renderer-ready protocol
- apply deterministic defaults and guards
- keep the same semantic structure across `pptx`, `docx`, `pdf`, and `xlsx`

The compiler is where Kyberion converts:

- business structure
- semantic section meaning
- design-system rules

into:

- format-ready protocol contracts

This is the layer that should absorb complexity, not the LLM and not the operator.

## 4. Renderer Layer

Renderers are deterministic.

Their responsibilities are:

- materialize binary output
- apply format-specific low-level rules
- preserve reproducibility

They should not decide:

- section ordering
- narrative structure
- semantic meaning

Those are already decided upstream.

## Canonical Path

The canonical media path is:

1. `document_outline_from_brief`
2. `brief_to_design_protocol`
3. `generate_document`

Legacy operators may remain as compatibility adapters, but they are not the primary path.

## Decision Rule

Use this rule whenever a new media feature is added:

- if it changes meaning or business structure, it belongs in knowledge
- if it maps meaning into a protocol, it belongs in the compiler
- if it writes a binary file, it belongs in the renderer
- if it drafts text or summarizes intent, it may belong to the LLM

## Why This Matters

Kyberion's strength is not "LLM-generated PowerPoint".

Kyberion's strength is:

- governed structure from knowledge
- semantic compilation into stable contracts
- deterministic physical execution
- optional LLM drafting inside explicit boundaries

That is what makes the system evolvable without turning execution into prompt spaghetti.
