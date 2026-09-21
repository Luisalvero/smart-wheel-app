"""Evaluates the SHIPPED model (lib/voice/intentModel.ts, rounded weights)
on the held-out phrases and writes the fixture the TypeScript test uses to
prove the phone computes the same probabilities.

    python3 tools/intent/check.py      (fast; no training)
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from phrases import TEST  # noqa: E402
from train import ROOT, features  # noqa: E402

src = open(os.path.join(ROOT, "lib", "voice", "intentModel.ts")).read()
model = json.loads(src[src.index("{"):src.rindex("}") + 1])
W = {row[0]: row[1:] for row in model["weights"]}


def probs(text):
    z = list(model["bias"])
    for i, v in features(text).items():
        w = W.get(i)
        if w:
            for k in range(3):
                z[k] += v * w[k]
    m = max(z)
    e = [math.exp(x - m) for x in z]
    s = sum(e)
    return [x / s for x in e]


rows = []
wrong = 0
for text, label in TEST:
    p = probs(text)
    guess = model["classes"][p.index(max(p))]
    wrong += guess != label
    rows.append({"text": text, "label": label, "probs": [round(x, 6) for x in p]})
with open(os.path.join(ROOT, "tests", "fixtures", "intent_parity.json"), "w") as f:
    json.dump(rows, f, indent=0)
print(f"shipped model: {len(TEST) - wrong}/{len(TEST)} held-out phrases correct")
