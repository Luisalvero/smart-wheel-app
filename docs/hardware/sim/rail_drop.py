#!/usr/bin/env python3
"""Voltage drop along the +5V_PAD ring, and what reaches the far pad.

Current is a MEASUREMENT, not a guess: measure one MAX30102 module at the LED
brightness the firmware sets, with an ammeter in its VIN lead, and pass it in.
Wire resistance is the nominal AWG figure at 20 C; the harness also has
connectors and splices, so treat the result as a floor, not a promise.

    python3 rail_drop.py --ma 25 --pads 16 --awg 22 --len 1.2
"""
import argparse

# Nominal solid-copper resistance at 20 C, ohm per metre (standard AWG table).
AWG = {28: 0.2327, 26: 0.1463, 24: 0.0920, 22: 0.0578, 20: 0.0364, 18: 0.0229, 16: 0.0144}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ma", type=float, required=True, help="MEASURED current of one pad, mA")
    ap.add_argument("--pads", type=int, default=16)
    ap.add_argument("--awg", type=int, default=22, choices=sorted(AWG))
    ap.add_argument("--len", type=float, default=1.2, help="one-way run to the far pad, m")
    ap.add_argument("--vsrc", type=float, default=5.0)
    ap.add_argument("--vmin", type=float, default=3.4, help="lowest acceptable module VIN")
    a = ap.parse_args()

    r_per_m = AWG[a.awg]
    i_all = a.ma * 1e-3 * a.pads          # worst case: every pad powered
    r_loop = 2 * a.len * r_per_m          # out and back
    drop = i_all * r_loop
    v_far = a.vsrc - drop
    print(f"  pads powered        : {a.pads} x {a.ma:.1f} mA = {i_all*1e3:.0f} mA")
    print(f"  wire                : AWG {a.awg}, {r_per_m*1000:.1f} mohm/m, loop {r_loop*1000:.0f} mohm")
    print(f"  drop at the far pad : {drop*1000:.0f} mV")
    print(f"  VIN at the far pad  : {v_far:.2f} V   "
          f"{'OK' if v_far >= a.vmin else 'TOO LOW - thicker wire, shorter run, or feed both ends'}")
    print(f"  power in the wire   : {i_all**2 * r_loop*1000:.0f} mW")
    print("\n  Current is your measurement; AWG resistance is nominal at 20 C and ignores")
    print("  connectors and splices. Powering only the pads in use cuts this proportionally.")

if __name__ == "__main__":
    main()
