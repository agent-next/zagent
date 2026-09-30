from solution import rot13
assert rot13("abc") == "nop"
assert rot13("Hello, World!") == "Uryyb, Jbeyq!"
assert rot13(rot13("MixEd 123 Zz")) == "MixED 123 Zz".replace("MixED","MixEd") or rot13(rot13("MixEd 123 Zz")) == "MixEd 123 Zz"
assert rot13("a-b_c") == "n-o_p"
print("PASS")
