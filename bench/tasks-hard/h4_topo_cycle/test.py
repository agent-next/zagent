from solution import topo_sort
g = {'a': ['b', 'c'], 'b': ['d'], 'c': ['d'], 'd': []}
order = topo_sort(g)
assert set(order) == {'a', 'b', 'c', 'd'}, order
pos = {n: i for i, n in enumerate(order)}
for u, vs in g.items():
    for v in vs:
        assert pos[u] < pos[v], f'edge {u}->{v} violated'
# node only as successor
g2 = {'a': ['b'], 'b': ['c']}
o2 = topo_sort(g2)
assert set(o2) == {'a', 'b', 'c'} and o2.index('a') < o2.index('b') < o2.index('c')
for bad in [{'a': ['b'], 'b': ['a']}, {'a': ['a']}]:
    try:
        topo_sort(bad); raise AssertionError('cycle not detected: ' + str(bad))
    except ValueError:
        pass
print('PASS')
