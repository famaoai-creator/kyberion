---
category: Added
---

- Browser actuator `approval_queue_inspect` signs in to a tenant business system with secret-guard credentials and counts its approval-pending list without approving anything. The browser is confined to the declared HTTPS origins: requests, redirect hops and WebSockets are blocked outside them, other host names do not resolve, and WebRTC is removed. A same-tenant organization charter can delegate the run only for one exact origin plus the SHA-256 of the signed profile, so scheduled checks no longer wait on a person.
- Zero rows count as "nothing pending" only when the profile's empty-state marker is shown, and a paginated list can report the system's own total. Every run is bounded at 180 seconds; failures name the phase, the session-free URL and any blocked hosts, are recorded as failed, and do not wait for a person to verify them.
- `pnpm kyberion browser approval-queue <profile>` prints a profile's hash, what it signs in with, and the grant to sign. A charter with a malformed grant now reports which grant is wrong and why.
