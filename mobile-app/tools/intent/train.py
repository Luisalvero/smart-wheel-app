"""Trains the on-device answer classifier for the voice check.

    python3 tools/intent/train.py          (needs numpy; run from mobile-app/)

Model: multinomial logistic regression over hashed features
  - word unigrams and bigrams (bigrams carry negation: "not okay", "no i'm")
  - character 3-5-grams over the padded text (robust to recogniser spelling:
    "okay"/"ok"/"k", "alright"/"all right", "si"/"sí")
hashed with 32-bit FNV-1a into DIM buckets, binary, L2-normalised. The TS
inference (lib/voice/intent.ts) reimplements exactly this featuriser; a parity
fixture written here is checked by tests/intent.test.ts.

Output: lib/voice/intentModel.ts (weights, ~120 KB) and
tests/fixtures/intent_parity.json. Prints held-out accuracy and, separately,
the number of critical errors (a not_ok answer classified as ok), which must
stay at zero.
"""
import json
import math
import os
import sys
import unicodedata

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from phrases import TEST, training_set  # noqa: E402

DIM = 4096
CLASSES = ["ok", "not_ok", "unclear"]
ROOT = os.path.join(os.path.dirname(__file__), "..", "..")


def normalise(text: str) -> str:
    t = unicodedata.normalize("NFD", text.lower().replace("’", "'"))
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    t = "".join(c if (c.isalnum() or c in "' ") else " " for c in t)
    return " ".join(t.split())


def fnv1a(s: str) -> int:
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def features(text: str) -> dict[int, float]:
    t = normalise(text)
    words = t.split()
    keys = [f"w:{w}" for w in words]
    keys += [f"b:{a}_{b}" for a, b in zip(words, words[1:])]
    padded = f" {t} "
    for n in (3, 4, 5):
        keys += [f"c:{padded[i:i + n]}" for i in range(len(padded) - n + 1)]
    idx = {fnv1a(k) % DIM for k in keys}
    if not idx:
        return {}
    v = 1.0 / math.sqrt(len(idx))
    return {i: v for i in idx}


def matrix(texts):
    X = np.zeros((len(texts), DIM), dtype=np.float32)
    for r, t in enumerate(texts):
        for i, v in features(t).items():
            X[r, i] = v
    return X


def softmax(z):
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def train(X, y, epochs=400, lr=0.8, l2=1e-4):
    n, d = X.shape
    k = len(CLASSES)
    W = np.zeros((d, k))
    b = np.zeros(k)
    Y = np.eye(k)[y]
    # class weights: balance the classes so "unclear" isn't drowned out
    cw = n / (k * np.bincount(y, minlength=k))
    sw = cw[y][:, None]
    mW, vW, mb, vb = (np.zeros_like(W), np.zeros_like(W), np.zeros_like(b), np.zeros_like(b))
    for t in range(1, epochs + 1):
        P = softmax(X @ W + b)
        G = (P - Y) * sw / n
        gW = X.T @ G + l2 * W
        gb = G.sum(axis=0)
        for p, g, m, v in ((W, gW, mW, vW), (b, gb, mb, vb)):   # Adam
            m *= 0.9
            m += 0.1 * g
            v *= 0.999
            v += 0.001 * g * g
            p -= lr * 0.01 * (m / (1 - 0.9 ** t)) / (np.sqrt(v / (1 - 0.999 ** t)) + 1e-8)
    return W, b


def main():
    rows = training_set()
    texts = [t for t, _ in rows]
    y = np.array([CLASSES.index(lab) for _, lab in rows])
    W, b = train(matrix(texts), y)

    def predict(t):
        return softmax(matrix([t]) @ W + b)[0]

    train_acc = np.mean([np.argmax(predict(t)) == CLASSES.index(lab) for t, lab in rows[:2000]])
    conf = np.zeros((3, 3), dtype=int)
    critical = []
    for t, lab in TEST:
        p = predict(t)
        guess = int(np.argmax(p))
        conf[CLASSES.index(lab), guess] += 1
        if lab == "not_ok" and CLASSES[guess] == "ok":
            critical.append((t, p.round(3).tolist()))
    acc = np.trace(conf) / conf.sum()
    print(f"training phrases: {len(rows)}   train acc (sample): {train_acc:.3f}")
    print(f"held-out test: {conf.sum()} phrases, accuracy {acc:.3f}")
    print("confusion (rows = truth, cols = predicted):", CLASSES)
    for c, row in zip(CLASSES, conf):
        print(f"  {c:8s} {row.tolist()}")
    print(f"critical errors (not_ok -> ok): {len(critical)}", critical)
    for t, lab in TEST:
        p = predict(t)
        if CLASSES[int(np.argmax(p))] != lab:
            print(f"  miss: {t!r:45s} truth={lab:8s} got={CLASSES[int(np.argmax(p))]:8s} p={p.round(2).tolist()}")

    model = {
        "version": 1,
        "dim": DIM,
        "classes": CLASSES,
        "bias": [round(float(x), 5) for x in b],
        # sparse: only buckets that carry weight, as [index, w_ok, w_not_ok, w_unclear]
        "weights": [[int(i)] + [round(float(x), 5) for x in W[i]] for i in range(DIM) if np.any(np.abs(W[i]) > 1e-6)],
        "trained_on": len(rows),
        "test_accuracy": round(float(acc), 4),
    }
    out = os.path.join(ROOT, "lib", "voice", "intentModel.ts")
    with open(out, "w") as f:
        # A .ts module rather than .json: Metro and Node both import it without
        # JSON import attributes.
        f.write("// Generated by tools/intent/train.py -- do not edit by hand.\n")
        f.write("export default ")
        json.dump(model, f, separators=(",", ":"))
        f.write(";\n")
    fixture = [{"text": t, "probs": [round(float(x), 6) for x in predict(t)]} for t, _ in TEST[:40]]
    os.makedirs(os.path.join(ROOT, "tests", "fixtures"), exist_ok=True)
    with open(os.path.join(ROOT, "tests", "fixtures", "intent_parity.json"), "w") as f:
        json.dump(fixture, f)
    print(f"wrote {out} ({os.path.getsize(out) // 1024} KB, {len(model['weights'])} active buckets)")


if __name__ == "__main__":
    main()
