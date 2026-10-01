from solution import binary_search
assert binary_search([1,3,5,7,9,11], 7) == 3
assert binary_search([1,3,5,7,9,11], 1) == 0
assert binary_search([1,3,5,7,9,11], 11) == 5
assert binary_search([1,3,5,7,9,11], 4) == -1
assert binary_search([], 5) == -1
assert binary_search([42], 42) == 0
print('PASS')
