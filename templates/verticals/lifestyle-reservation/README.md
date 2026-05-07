# Vertical Template: Lifestyle Reservation

Automate making reservations on behalf of the user, with judgment about choices:

1. Receive a high-level intent (`今夜のレストランを予約したい`、`美容院を空いてる時間で予約して`).
2. Search for available slots that match the user's preferences (location, time window, price band).
3. Surface 2–3 candidates with rationale.
4. Make the reservation after user confirms (or auto-confirm if delegation is granted).
5. Add to calendar and notify.

Targets: power users delegating personal life logistics, family / household coordination.

## Customer-specific inputs

| Input | Where to find it | Example |
|---|---|---|
| `RESERVATION_DOMAINS` | List of sites the user has accounts on | `["tabelog.com", "ozmall.co.jp", "hot-pepper-beauty"]` |
| `PREFERENCES_PATH` | User's preferences file | `customer/{slug}/preferences/lifestyle.json` |
| `CALENDAR_CONNECTION` | Google Calendar / etc. | (from `connections/google-workspace.json`) |
| `AUTO_CONFIRM_BELOW` | Spend threshold for auto-confirm | `5000` (yen) |
| `NOTIFICATION_CHANNEL` | Where to confirm to user | `slack:@you` or `email:you@example.com` |

## Smoke test

```bash
KYBERION_REASONING_BACKEND=stub pnpm pipeline --input templates/verticals/lifestyle-reservation/pipeline.json
```
