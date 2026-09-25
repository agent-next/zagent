---
description: Show coding-plan quota (balance | preview | reset)
---
Run the zagent-quota CLI from the zagent repo root and display the JSON result as a
formatted panel. Use argument to select which oracle (balance, preview, or reset).
Show the most important fields: for balance/preview show plans and balances; for
reset show available_five_hour_resets and available_week_resets with their expire_at
timestamps converted to human-readable dates.
