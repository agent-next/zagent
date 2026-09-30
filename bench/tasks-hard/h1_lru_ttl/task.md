Implement a Python module with a class `LRUCache`.

- `LRUCache(capacity, clock=lambda: 0)` — `clock` is a zero-arg callable returning the current time (seconds).
- `put(key, value, ttl=None)` — insert/update. `ttl` (seconds) makes the entry expire once `clock() >= insert_time + ttl`. `ttl=None` never expires by time.
- `get(key)` — return the value, or `None` if missing or expired. A successful `get` counts as a use (most-recently-used).
- When inserting a NEW key would exceed `capacity`, evict the least-recently-used key first. Expired entries must never be returned and must not count toward capacity when they are observed.

Reply with ONLY one Python code block containing the module (class `LRUCache`), no explanation.
