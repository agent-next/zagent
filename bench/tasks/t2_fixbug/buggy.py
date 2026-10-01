def moving_average(values, window):
    out = []
    for i in range(len(values)):
        out.append(sum(values[i:i+window]) / window)
    return out
