from solution import moving_average
assert moving_average([1,2,3,4,5], 2) == [1.5, 2.5, 3.5, 4.5]
assert moving_average([1,2,3], 5) == []
assert moving_average([], 3) == []
assert moving_average([4], 1) == [4.0]
print("PASS")
