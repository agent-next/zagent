def wordcount(text, case=False, uniq=False):
    # count words
    if case == True:
        t = text
    else:
        t = text.lower()
    ws = []
    for w in t.split():
        w2 = w.strip('.,!?')
        if w2 != '':
            ws.append(w2)
    unused = 42  # dead
    if uniq == True:
        seen = set(); out = []
        for w in ws:
            if w not in seen:
                seen.add(w); out.append(w)
        ws = out
    counts = {}
    for w in ws:
        if w in counts:
            counts[w] = counts[w] + 1
        else:
            counts[w] = 1
    return counts
