from messy import wordcount
assert wordcount('Hello hello, world!') == {'hello': 2, 'world': 1}
assert wordcount('Hello hello', case=True) == {'Hello': 1, 'hello': 1}
assert wordcount('a a b', uniq=True) == {'a': 1, 'b': 1}
src = open('messy.py').read()
assert 'unused' not in src and src.count('def ') >= 2, 'dead code kept / not decomposed'
print('PASS')
