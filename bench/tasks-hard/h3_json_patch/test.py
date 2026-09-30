from solution import apply_patch
import copy
d = {'a': {'b': [1, 2, 3]}, 'x': 10}
snapshot = copy.deepcopy(d)
r = apply_patch(d, [
    {'op': 'add', 'path': '/a/b/-', 'value': 4},
    {'op': 'replace', 'path': '/x', 'value': 20},
    {'op': 'remove', 'path': '/a/b/0'},
    {'op': 'copy', 'from': '/x', 'path': '/y'},
    {'op': 'move', 'from': '/y', 'path': '/z'},
    {'op': 'test', 'path': '/z', 'value': 20},
])
assert r == {'a': {'b': [2, 3, 4]}, 'x': 20, 'z': 20}, r
assert d == snapshot, 'input document was mutated'
try:
    apply_patch({'a': 1}, [{'op': 'test', 'path': '/a', 'value': 2}]); raise AssertionError('failed test must raise')
except ValueError:
    pass
try:
    apply_patch({'a': 1}, [{'op': 'remove', 'path': '/nope'}]); raise AssertionError('bad path must raise')
except ValueError:
    pass
print('PASS')
