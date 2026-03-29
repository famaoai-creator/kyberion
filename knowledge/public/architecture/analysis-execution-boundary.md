# Analysis Execution Boundary

Kyberion's analysis and review flows should follow the same principle as media generation:

`intent -> governed process -> compiled execution contract -> deterministic persistence / follow-up`

This means analysis work is not "LLM review with optional notes".

It is a governed execution path.

## Zones

### 1. LLM Zone

The LLM may:

- normalize the user's review or remediation request
- draft findings language
- summarize incident or requirement history
- phrase follow-up recommendations

The LLM must not:

- invent governed process steps
- invent repository or PR bindings
- declare verification complete without evidence
- mutate runtime state directly

### 2. Knowledge Zone

Knowledge owns:

- intent definitions
- process design
- outcome catalog
- specialist routing
- track / governance model

This is where Kyberion defines how a review or remediation request should progress.

### 3. Compiler Zone

The compiler layer is responsible for:

- resolving review targets
- ranking governed refs
- classifying impact bands
- producing finding candidates
- producing the execution contract used by follow-up seeds and missions

This is the layer that turns semantic analysis into reproducible follow-up work.

### 4. Executor Zone

Execution/runtime is responsible for:

- writing the governed analysis artifact
- creating follow-up mission seeds
- preserving project / track / evidence context

It should not reinterpret the request strategically.

## Durable Contract Placement

For analysis flows, the boundary should be visible in:

- `work_loop.execution_boundary`
- analysis artifacts
- follow-up seed `execution_contract`

That way the runtime record itself explains:

- what the LLM was allowed to do
- what knowledge controlled
- what the compiler bound
- what execution persisted

## Principle

The Kyberion form of review is:

- LLM drafts findings language
- knowledge defines the governed process
- the compiler binds targets and follow-up contracts
- the executor writes artifacts and seeds

That is how review remains both intelligent and reproducible.
