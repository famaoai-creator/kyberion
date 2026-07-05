# Surfaces

This is the operator-facing map of Kyberion entry points.

| Surface          | Main use                                               | Start command                                       | Not for                                  |
| ---------------- | ------------------------------------------------------ | --------------------------------------------------- | ---------------------------------------- |
| Chronos          | Home, plan preview, mission intervention, inbox glance | `pnpm chronos`                                      | Long-form editing or raw data export     |
| operator-surface | Read-only mission and inbox inspection                 | `pnpm --dir presence/displays/operator-surface dev` | Planning and intervention                |
| Slack            | Conversation, approvals, notification receipt          | bridge process                                      | Deep history browsing                    |
| Voice            | Hands-free conversation                                | voice pipeline / bridge                             | Bulk review or command-line work         |
| `pnpm kyberion`  | Single operator home summary                           | `pnpm kyberion`                                     | Direct mutation or mission orchestration |
| `pnpm cli`       | Script-oriented CLI entry point                        | `pnpm cli`                                          | Unified operator home and summary        |
| presence-studio  | Presence and conversation surfacing                    | display app                                         | Durable mission ownership                |
| computer-surface | Desktop/UI automation surfaces                         | display app                                         | Mission planning                         |
| avatar-studio    | Avatar and media workspaces                            | display app                                         | Read-only ops review                     |

Related guidance:

- [`docs/OPERATOR_UX_GUIDE.md`](./OPERATOR_UX_GUIDE.md)
- [`README.md`](../README.md)
