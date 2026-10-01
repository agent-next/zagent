from solution import toposort
r = toposort([("a","b"),("a","c"),("b","d"),("c","d")])
assert r.index("a") < r.index("b") and r.index("a") < r.index("c") and r.index("b") < r.index("d") and r.index("c") < r.index("d")
try:
    toposort([("x","y"),("y","x")]); assert False
except ValueError as e:
    assert "cycle" in str(e)
print("PASS")
