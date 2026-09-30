from shapes import Circle
from report import describe
c = Circle(2)
assert hasattr(c, 'area'), 'area() missing'
import math
assert abs(c.area() - math.pi * 4) < 1e-9
d = describe(c)
assert 'area=12.57' in d, d
print('PASS')
