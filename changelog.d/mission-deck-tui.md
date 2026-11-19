---
category: Added
---

- **Mission Deck (`pnpm deck` / `pnpm kyberion deck`)** — a new terminal UI built around conversation. Items waiting on you (decisions, reviews, blocked and running missions) are listed on the left. The conversation in the middle shows each decision as a card (recommendation, what happens if you don't answer, whether it can be undone) and previews how your request was understood before anything is sent. On the right are your herdr agents: you can peek at their output, reply, add a note, interrupt or attach. Approving or denying opens the governed `kyberion approvals` screen and returns to the deck afterwards. `--once` prints a plain-text snapshot (CI or no TTY), and `--view missions|terminals` picks the starting view. The terminal HUD (`pnpm tui`) is unchanged.
