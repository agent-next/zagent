from solution import merge_dicts
assert merge_dicts({'a':1,'b':2}, {'b':3,'c':4}) == {'a':1,'b':3,'c':4}
assert merge_dicts({'a':1}, a=10, b=20) == {'a':10,'b':20}
assert merge_dicts() == {}
assert merge_dicts({'x':1}, {'x':2}, {'x':3}) == {'x':3}
print('PASS')
