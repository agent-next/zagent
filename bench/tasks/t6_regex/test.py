from solution import parse_log
r = parse_log('2026-09-04T12:34:56 INFO user=alice action=login ok')
assert r == {'ts': '2026-09-04T12:34:56', 'level': 'INFO', 'user': 'alice', 'action': 'login', 'ok': True}, r
assert parse_log('garbage') is None
r2 = parse_log('2026-01-01T00:00:00 WARN user=bob action=x')
assert r2['ok'] is False and r2['level'] == 'WARN'
print('PASS')
