---
category: Changed
---

- 使い方 (`/help`, `/help/<track>`) is now a Concierge page instead of a presence-studio page (Kyberion server phase 2).
  - The rail's help link opens it in Concierge; the old Studio addresses (and `/help.html`) redirect there with the query kept.
  - It lists the training tracks with how many lessons you have done, and each lesson's "try it" goes to the page that does it. Decision lessons now go to 受信箱 instead of 進み具合, and only when your role can open 受信箱 (otherwise 進み具合).
  - A member's own lesson record moves to `GET/POST /api/training/me`; Studio's own-progress, `/api/training/vocabulary` and `/api/help-vocabulary` endpoints are removed. Marking a lesson done keeps Studio's rule exactly: a loopback `localadmin` session only, plus the Concierge mutation gate. Refusals (not a member, not this computer's session, unknown lesson) are shown in the page's own words.
