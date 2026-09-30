Implement a Python module exposing `apply_patch(doc, ops)`.

Apply an RFC 6902 JSON-Patch subset to a nested structure of dicts/lists and RETURN the new document WITHOUT mutating the input. Support ops: `add`, `remove`, `replace`, `move`, `copy`, `test`. Paths are JSON Pointers (`/a/b/0`); the array token `-` in an `add` path means append. `move`/`copy` read a `from` pointer. A failed `test` (value not deep-equal) raises `ValueError`; so does any invalid/missing path.

Reply with ONLY one Python code block containing the module (function `apply_patch`), no explanation.
