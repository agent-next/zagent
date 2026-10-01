from solution import safe_divide
assert safe_divide(10, 2) == 5.0
assert safe_divide(10, 0) == "error: division by zero"
assert safe_divide("a", 2) == "error: type"
assert safe_divide(10, "b") == "error: type"
assert safe_divide(-6, 3) == -2.0
print('PASS')
