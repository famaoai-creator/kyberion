Retired pipeline definitions are kept here for historical reference only; active runtime discovery and validation should use `pipelines/` or `knowledge/product/pipeline-templates/`.

## Entries retired by the orphan-wiring audit (OW-04, 2026-10-01)

| File                                      | Reason                                                                                                                                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate-dt-security-proposal-pptx.json` | Customer-specific proposal build that hardcoded `knowledge/confidential/sbidt/...` inputs and a customer-named output in the public pipeline tier; no parameters, no caller, unrunnable without that tenant's files. |
