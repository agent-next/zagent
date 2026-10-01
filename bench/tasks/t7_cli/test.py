import io, contextlib
from solution import main
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = main(['prog', 'add', '2', '3'])
assert rc == 0 and buf.getvalue().strip() == '5'
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = main(['prog', 'echo', 'hi'])
assert rc == 0 and buf.getvalue().strip() == 'HI'
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = main(['prog', 'nope'])
assert rc == 2 and 'usage' in buf.getvalue()
print('PASS')
