Implement a Python module exposing `diff_lines(a, b)`.

`a` and `b` are lists of strings. Return an edit script: a list of `(op, line)` tuples where `op` is `'keep'`, `'del'`, or `'add'`. Applying the script to `a` (keep/del consume from `a`, add/keep emit to output) must reconstruct `b`, and the number of `keep` ops must equal the length of the Longest Common Subsequence of `a` and `b` (i.e. a minimal-change diff).

Reply with ONLY one Python code block containing the module (function `diff_lines`), no explanation.
