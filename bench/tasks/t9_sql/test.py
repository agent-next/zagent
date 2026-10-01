from solution import query
rows = [{'k': 'b', 'v': 2}, {'k': 'a', 'v': 1}, {'k': 'c', 'v': 1}]
assert query(rows, order_by='v') == [{'k': 'a', 'v': 1}, {'k': 'c', 'v': 1}, {'k': 'b', 'v': 2}]
assert query(rows, select=['k'], where=lambda r: r['v'] == 1) == [{'k': 'a'}, {'k': 'c'}]
assert query(rows, order_by='v', desc=True)[0]['k'] == 'b'
print('PASS')
