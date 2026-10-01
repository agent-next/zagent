from solution import reverse_words
assert reverse_words("hello world") == "world hello"
assert reverse_words("  the   quick  brown  ") == "brown quick the"
assert reverse_words("") == ""
assert reverse_words("one") == "one"
print('PASS')
