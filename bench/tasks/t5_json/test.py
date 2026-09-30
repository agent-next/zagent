from solution import flatten_json
assert flatten_json({"a": {"b": 1, "c": {"d": 2}}, "e": [1, 2]}) == {"a.b": 1, "a.c.d": 2, "e": [1, 2]}
assert flatten_json({}) == {}
assert flatten_json({"x": 0}) == {"x": 0}
print('PASS')
