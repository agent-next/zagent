from solution import ApiClient
class Flaky:
    def __init__(self): self.calls = 0
    def request(self, method, path, json=None):
        self.calls += 1
        if self.calls < 3: raise ConnectionError('boom')
        return {'ok': True, 'method': method, 'path': path}
f = Flaky()
c = ApiClient(f)
assert c.get('/x') == {'ok': True, 'method': 'GET', 'path': '/x'} and f.calls == 3
class Dead:
    def request(self, method, path, json=None): raise ConnectionError('dead')
try:
    ApiClient(Dead()).post('/y', {'a': 1}); assert False
except ConnectionError: pass
print('PASS')
