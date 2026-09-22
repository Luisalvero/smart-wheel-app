#!/usr/bin/env python3
"""SPICE model of the +5V_PAD ring: a ladder, not a single lumped drop.

The pads are spread around the rim, so each one sits further along the wire and
sees a different voltage. This writes an ngspice netlist with one resistor per
span and one current sink per pad, on both the feed and the return, and asks
for the voltage at every pad.

    python3 rail_spice.py --ma 25 --pads 16 --awg 22 --len 1.2 --spice rail.cir
    ngspice -b rail.cir
"""
import argparse

AWG = {28: 0.2327, 26: 0.1463, 24: 0.0920, 22: 0.0578, 20: 0.0364, 18: 0.0229, 16: 0.0144}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ma", type=float, required=True, help="MEASURED current of one pad, mA")
    ap.add_argument("--pads", type=int, default=16)
    ap.add_argument("--awg", type=int, default=22, choices=sorted(AWG))
    ap.add_argument("--len", type=float, default=1.2, help="total ring length, m")
    ap.add_argument("--vsrc", type=float, default=5.0)
    ap.add_argument("--spice", default="rail.cir")
    ap.add_argument("--both-ends", action="store_true", help="feed the ring from both ends")
    a = ap.parse_args()

    r_span = AWG[a.awg] * (a.len / a.pads)
    lines = [f"* +5V_PAD ring: {a.pads} pads, {a.len} m of AWG {a.awg}, {a.ma} mA per pad",
             f"* span resistance {r_span*1000:.1f} mohm, feed and return both modelled",
             f"Vsrc vsrc 0 DC {a.vsrc}"]
    for i in range(1, a.pads + 1):
        prev_f = "vsrc" if i == 1 else f"f{i-1}"
        prev_r = "0" if i == 1 else f"r{i-1}"
        lines += [f"Rf{i} {prev_f} f{i} {r_span:.6f}",
                  f"Rr{i} {prev_r} r{i} {r_span:.6f}",
                  f"Ipad{i} f{i} r{i} DC {a.ma/1000:.6f}"]
    if a.both_ends:
        lines.append(f"Rfe vsrc f{a.pads} {r_span:.6f}")
        lines.append(f"Rre 0 r{a.pads} {r_span:.6f}")
    probes = " ".join(f"v(f{i},r{i})" for i in range(1, a.pads + 1))
    lines += [".control", "op", f"print {probes}",
              f"let worst = v(f{a.pads},r{a.pads})", "print worst", ".endc", ".end", ""]
    with open(a.spice, "w") as f:
        f.write("\n".join(lines))
    print(f"wrote {a.spice}: ladder of {a.pads} pads, span {r_span*1000:.1f} mohm, "
          f"total {a.ma*a.pads:.0f} mA")
    print(f"run it with:  ngspice -b {a.spice}")

if __name__ == "__main__":
    main()
