---
category: Fixed
---

- **Knowledge usage feedback now reaches ranking, weight proposals and the curation report.** Deliveries were recorded at mission scope, worker used/not-used feedback at task scope, and every reader looked somewhere else (weight proposals and the curation report read the tenant level, retrieval read the mission level). Usage signals from tenant missions were never seen. The usage aggregate is now one file per tenant (`tenants/{tenant}/knowledge-usage/usage.json`), while the delivery JSONL logs stay partitioned per mission. Aggregates already written under mission or task folders are not merged.
- **Retry knowledge for unresolved `needs` uses the mission's scope.** A confidential mission's retry lookup now searches its own tenant's distills and applies the same slice excludes as the first-round pack, so excluded `distill_*.md` notes no longer slip into retries.
- **Missions without a project find their own knowledge.** Dispatch fills a work item's `project_id` with the mission id when there is no project. The context pack no longer treats that placeholder as a project, so documents under `knowledge/confidential/{tenant}/missions/{mission}/` are retrieved again, and the scope gate no longer carries a fake project.
- **`wisdom:knowledge_search` scans only the caller's own organization, project and mission.** It used to scan the whole tenant tree, including sibling projects and missions.
- **`knowledge/personal/` is never labelled public at the pack scope gate.** A pinned personal document is now treated as personal-tier and rejected for public and tenant missions.
- **Relevance narrowing no longer shrinks the pack below its budget.** When a calibrated relevance judgment is available, it judges twice as many candidates and the pack is then capped, so dropped hints are replaced. Without a calibrated judgment, behaviour is unchanged.
