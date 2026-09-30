from solution import Stack
s = Stack()
assert s.is_empty() and s.size() == 0
s.push(1); s.push(2); s.push(3)
assert s.size() == 3 and not s.is_empty()
assert s.peek() == 3 and s.size() == 3
assert s.pop() == 3 and s.size() == 2
assert s.pop() == 2 and s.pop() == 1
assert s.pop() is None and s.is_empty()
assert s.peek() is None
print('PASS')
