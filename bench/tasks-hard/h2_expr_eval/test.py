from solution import evaluate
assert evaluate('1+2*3') == 7
assert evaluate('(1+2)*3') == 9
assert evaluate('-3 + 4 * -2') == -11
assert abs(evaluate('10/4') - 2.5) < 1e-9
assert evaluate('2*(3+(4-1))') == 12
assert abs(evaluate(' 3.5 * 2 ') - 7.0) < 1e-9
for bad in ['1+', '(1+2', '1/0', '', '2**3', 'abc', '3 4', '*3']:
    try:
        evaluate(bad); raise AssertionError('should have raised on: ' + repr(bad))
    except (ValueError, ZeroDivisionError):
        pass
print('PASS')
