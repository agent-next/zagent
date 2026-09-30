from solution import diff_lines
def lcs_len(a, b):
    m, n = len(a), len(b)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m):
        for j in range(n):
            dp[i + 1][j + 1] = dp[i][j] + 1 if a[i] == b[j] else max(dp[i][j + 1], dp[i + 1][j])
    return dp[m][n]
def check(a, b):
    ops = diff_lines(a, b)
    out, ai = [], 0
    for op, line in ops:
        if op == 'keep':
            assert ai < len(a) and a[ai] == line, ('keep mismatch', op, line, ai)
            out.append(line); ai += 1
        elif op == 'del':
            assert ai < len(a) and a[ai] == line, ('del mismatch', op, line, ai)
            ai += 1
        elif op == 'add':
            out.append(line)
        else:
            raise AssertionError('bad op ' + repr(op))
    assert ai == len(a), 'did not consume all of a'
    assert out == b, ('reconstruction failed', out, b)
    kept = sum(1 for op, _ in ops if op == 'keep')
    assert kept == lcs_len(a, b), ('not minimal: kept', kept, 'lcs', lcs_len(a, b))
check(['x', '1', '2', '3', 'y'], ['1', '2', 'z', '3'])
check(['a', 'b', 'c'], ['a', 'b', 'c'])
check([], ['a', 'b'])
check(['a', 'b'], [])
check(['a', 'x', 'b', 'y', 'c'], ['a', 'b', 'c'])
print('PASS')
