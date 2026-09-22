#!/usr/bin/env python3
"""Compares the netlist KiCad exports against harness_spec.py and the drawing.

This is the cross-check: the schematic is generated from the spec, KiCad then
re-extracts connectivity from the schematic geometry, and this script proves
the round trip matches. A stub wire that missed its pin, or a label typo,
shows up here as a difference.

    kicad-cli sch export netlist --format kicadsexpr -o wheel_harness.net wheel_harness.kicad_sch
    python3 check_netlist.py wheel_harness.net
"""
import re
import sys
from pathlib import Path

import harness_spec as spec

def parse(text: str) -> dict[str, set[tuple[str, str]]]:
    """Pulls (net name -> {(ref, pin)}) out of KiCad's sexpr netlist."""
    nets: dict[str, set[tuple[str, str]]] = {}
    for m in re.finditer(r'\(net\s+\(code\s+"?\d+"?\)\s*\(name\s+"([^"]*)"\)(.*?)(?=\(net\s+\(code|\Z)',
                         text, re.S):
        name = m.group(1).lstrip("/")
        pins = set(re.findall(r'\(node\s+\(ref\s+"([^"]+)"\)\s*\(pin\s+"([^"]+)"\)', m.group(2)))
        if pins:
            nets[name] = pins
    return nets

def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "wheel_harness.net")
    if not path.exists():
        print(f"no netlist at {path} - export it from the schematic first")
        return 2
    got = parse(path.read_text())
    want = {n: {tuple(p) for p in pins} for n, pins in spec.NETS.items()}
    bad = 0

    missing = sorted(set(want) - set(got))
    extra = sorted(n for n in set(got) - set(want) if not n.startswith("unconnected-"))
    for n in missing:
        print(f"MISSING NET in the schematic: {n}")
        bad += 1
    for n in extra:
        print(f"UNEXPECTED NET in the schematic: {n} -> {sorted(got[n])}")
        bad += 1
    for n in sorted(set(want) & set(got)):
        if want[n] != got[n]:
            print(f"NET {n} differs")
            for p in sorted(want[n] - got[n]):
                print(f"    only in the spec:      {p[0]} pin {p[1]}")
            for p in sorted(got[n] - want[n]):
                print(f"    only in the schematic: {p[0]} pin {p[1]}")
            bad += 1

    # design rules that the drawing claims and that must hold in the netlist
    for i in range(8):
        for pre, first in (("A", 1), ("B", 9)):
            for sig in ("SDA", "SCL"):
                net = f"{sig}_{pre}{i}"
                pads = {r for r, _ in got.get(net, ()) if r.startswith("MOD")}
                if len(pads) != 1:
                    print(f"RULE: {net} should reach exactly one pad, reaches {sorted(pads)}")
                    bad += 1
    pads_on_5v = {r for r, _ in got.get("+5V_PAD", ()) if r.startswith("MOD")}
    if len(pads_on_5v) != 16:
        print(f"RULE: +5V_PAD should feed 16 pads, feeds {len(pads_on_5v)}")
        bad += 1
    gnd_refs = {r for r, _ in got.get("GND", ())}
    for ref in spec.PARTS:
        if ref.startswith(("MOD", "U", "A", "PS")) and ref not in gnd_refs and ref != "PWR2" and ref != "PWR3":
            print(f"RULE: {ref} has no ground connection")
            bad += 1
    print(f"\n{len(want)} nets compared - {'ALL MATCH' if bad == 0 else f'{bad} PROBLEM(S)'}")
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main())
