---
category: Changed
---

- Every lease now goes through one primitive in `libs/core/lease/`: WorkItem claims, Mission Lease, Co-Session path leases and video/audio device leases name a resource kind (`work_item`, `mission`, `path`, `device`, `dot_slot`) and a resource, and `lease-terms.ts` decides the holder, the expiry and the generation (`fence`). Dot arbitration keeps reading WorkItem claims and holds no lease of its own.
- Lease records carry a `fence` that increases with each new holder. WorkItem leases and Co-Session path leases written before this change have no fence and count as generation 0; nothing needs migrating.
- Each acquire, renew, release and expiry is written to the audit chain in one shape (`lease.acquire|renew|release|expire`, operation `<kind>:<resource>`).
- Device leases are fenced records on the lease-backend seam at their old path. A live device lease file in the old format still blocks a second session until it expires. A released device keeps its record, so the generation counter is not lost. A heartbeat renews at most every third of the TTL, re-acquires a stalled lease that nobody else took, and now fails on audio devices too when another session has taken the device.
- `tests/lease-bookkeeping-boundary.test.ts` fails when code outside `libs/core/lease/` computes a lease expiry, holder or fence.
