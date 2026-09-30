from solution import LRUCache
t = [0]
c = LRUCache(2, clock=lambda: t[0])
c.put('a', 1); c.put('b', 2)
assert c.get('a') == 1                 # 'a' now MRU, 'b' LRU
c.put('c', 3)                          # evicts LRU 'b'
assert c.get('b') is None, 'LRU eviction wrong'
assert c.get('a') == 1 and c.get('c') == 3
c.put('d', 4, ttl=5)
t[0] = 4; assert c.get('d') == 4, 'should not be expired yet'
t[0] = 6; assert c.get('d') is None, 'ttl expiry failed'
# update refreshes recency
t[0] = 6
c = LRUCache(2, clock=lambda: t[0])
c.put('x', 1); c.put('y', 2); c.put('x', 10)   # touch x
c.put('z', 3)                                   # should evict y, not x
assert c.get('x') == 10 and c.get('y') is None and c.get('z') == 3
print('PASS')
