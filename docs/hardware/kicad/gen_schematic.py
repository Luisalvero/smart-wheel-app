#!/usr/bin/env python3
"""Generates a real KiCad schematic from harness_spec.py.

Every pin gets a short stub wire ending in a net label, which is how large
buses are drawn in practice and which makes connectivity exactly what the spec
says -- no hand routing to get wrong. Run ERC with:

    python3 gen_schematic.py
    kicad-cli sch erc --severity-all --exit-code-violations wheel_harness.kicad_sch
    kicad-cli sch export pdf --output wheel_harness_schematic.pdf wheel_harness.kicad_sch
    kicad-cli sch export netlist --format kicadsexpr -o wheel_harness.net wheel_harness.kicad_sch
"""
import uuid as _uuid
from pathlib import Path

import harness_spec as spec

PROJECT = "wheel_harness"
GRID = 1.27
STUB = 5.08

def uid() -> str:
    return str(_uuid.uuid4())

def snap(v: float) -> float:
    return round(round(v / GRID) * GRID, 4)

# --------------------------------------------------------- symbol bodies ---
def body_size(pins):
    left = [p for p in pins if p[3] == "L"]
    right = [p for p in pins if p[3] == "R"]
    rows = max(len(left), len(right), 1)
    h = rows * 2.54 + 2.54
    longest = max((len(p[1]) for p in pins), default=4)
    w = max(20.32, 2.54 * 4 + longest * 1.6)
    return w, h, left, right

def pin_positions(pins):
    """library coordinates (+Y up) of each pin's connection point"""
    w, h, left, right = body_size(pins)
    pos = {}
    for i, p in enumerate(left):
        pos[p[0]] = (-w / 2 - 2.54, h / 2 - 2.54 * (i + 1), 0)
    for i, p in enumerate(right):
        pos[p[0]] = (w / 2 + 2.54, h / 2 - 2.54 * (i + 1), 180)
    return pos, w, h

def lib_symbol(name, pins) -> str:
    pos, w, h = pin_positions(pins)
    out = [f'    (symbol "harness:{name}" (pin_names (offset 0.508)) (in_bom yes) (on_board yes)',
           f'      (property "Reference" "U" (at 0 {h/2+2.54:.2f} 0) (effects (font (size 1.27 1.27))))',
           f'      (property "Value" "{name}" (at 0 {-h/2-2.54:.2f} 0) (effects (font (size 1.27 1.27))))',
           '      (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))',
           '      (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))',
           f'      (symbol "{name}_0_1"',
           f'        (rectangle (start {-w/2:.2f} {-h/2:.2f}) (end {w/2:.2f} {h/2:.2f})',
           '          (stroke (width 0.254) (type default)) (fill (type background)))',
           '      )',
           f'      (symbol "{name}_1_1"']
    for num, pname, ptype, _side in pins:
        x, y, ang = pos[num]
        out.append(f'        (pin {ptype} line (at {x:.2f} {y:.2f} {ang}) (length 2.54)')
        out.append(f'          (name "{pname}" (effects (font (size 1.27 1.27))))')
        out.append(f'          (number "{num}" (effects (font (size 1.016 1.016)))))')
    out += ['      )', '    )']
    return "\n".join(out)

# ------------------------------------------------------------- placement ---
def place() -> dict[str, tuple[float, float]]:
    """Columns: power chain, controllers, multiplexers, pads, passives."""
    at: dict[str, tuple[float, float]] = {}
    col = {"power": 40.0, "ctrl": 150.0, "mux": 300.0, "pad": 460.0, "misc": 620.0}
    for i, ref in enumerate(["BT1", "F1", "SW1", "F2", "F3", "PS1", "PS2", "TB2"]):
        at[ref] = (col["power"], 40.0 + i * 46.0)
    for i, ref in enumerate(["A1", "A2", "U3"]):
        at[ref] = (col["ctrl"], 50.0 + i * 90.0)
    at["U1"] = (col["mux"], 120.0)
    at["U2"] = (col["mux"], 340.0)
    for n in range(1, 17):
        row, c = (n - 1) % 8, (n - 1) // 8
        at[f"MOD{n:02d}"] = (col["pad"] + c * 110.0, 40.0 + row * 46.0)
    for i, ref in enumerate(["R1", "R2", "R3", "R4", "R5", "R6", "PWR1", "PWR2", "PWR3"]):
        at[ref] = (col["misc"] + 220.0, 40.0 + i * 34.0)
    return {k: (snap(x), snap(y)) for k, (x, y) in at.items()}

def main():
    idx = spec.pin_index()
    at = place()
    root = uid()
    used = {}
    for ref, (sym, *_rest) in spec.PARTS.items():
        used.setdefault(sym, spec.PARTS[ref][3])

    S = ['(kicad_sch (version 20231120) (generator "ppg_harness_gen")',
         f'  (uuid "{root}")',
         '  (paper "A1")',
         '  (title_block',
         '    (title "Biometric Steering Wheel - 16 PPG pad harness")',
         '    (date "2026-09-22") (rev "A")',
         '    (company "Team 18 - FIU Senior Design")',
         '    (comment 1 "TD18-HW-002 - generated from harness_spec.py")',
         '    (comment 2 "NOT A MEDICAL DEVICE - student prototype")',
         '  )',
         '  (lib_symbols']
    for sym, pins in used.items():
        S.append(lib_symbol(sym, pins))
    S.append('  )')

    wires, labels, ncs = [], [], []
    for ref, (sym, value, _desc, pins) in spec.PARTS.items():
        X, Y = at[ref]
        pos, w, h = pin_positions(pins)
        S.append(f'  (symbol (lib_id "harness:{sym}") (at {X:.2f} {Y:.2f} 0) (unit 1)')
        S.append('    (in_bom yes) (on_board yes) (dnp no) (fields_autoplaced yes)')
        S.append(f'    (uuid "{uid()}")')
        S.append(f'    (property "Reference" "{ref}" (at {X:.2f} {Y - h/2 - 3.5:.2f} 0)'
                 '      (effects (font (size 1.27 1.27))))')
        S.append(f'    (property "Value" "{value}" (at {X:.2f} {Y + h/2 + 3.5:.2f} 0)'
                 '      (effects (font (size 1.27 1.27))))')
        S.append('    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))')
        S.append('    (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))')
        for num, *_ in pins:
            S.append(f'    (pin "{num}" (uuid "{uid()}"))')
        S.append(f'    (instances (project "{PROJECT}"')
        S.append(f'      (path "/{root}" (reference "{ref}") (unit 1))))')
        S.append('  )')

        for num, pname, _ptype, side in pins:
            px, py, _ang = pos[num]
            ax, ay = snap(X + px), snap(Y - py)          # library +Y up -> sheet +Y down
            out = -STUB if side == "L" else STUB
            bx = snap(ax + out)
            net = idx.get((ref, num))
            if net is None:
                ncs.append(f'  (no_connect (at {ax:.2f} {ay:.2f}) (uuid "{uid()}"))')
                continue
            wires.append('  (wire (pts (xy %.2f %.2f) (xy %.2f %.2f))\n'
                         '    (stroke (width 0) (type default)) (uuid "%s"))' % (ax, ay, bx, ay, uid()))
            rot = 180 if side == "L" else 0
            just = "right" if side == "L" else "left"
            labels.append(f'  (label "{net}" (at {bx:.2f} {ay:.2f} {rot})\n'
                          f'    (effects (font (size 1.27 1.27)) (justify {just} bottom)) (uuid "{uid()}"))')
    S += wires + labels + ncs
    S.append('  (sheet_instances (path "/" (page "1")))')
    S.append(')')

    out = Path(__file__).parent / f"{PROJECT}.kicad_sch"
    out.write_text("\n".join(S) + "\n")
    pro = Path(__file__).parent / f"{PROJECT}.kicad_pro"
    if not pro.exists():
        pro.write_text('{\n  "board": {},\n  "meta": {"filename": "%s.kicad_pro", "version": 1},\n'
                       '  "schematic": {},\n  "sheets": [],\n  "text_variables": {}\n}\n' % PROJECT)
    n_parts, n_nets = len(spec.PARTS), len(spec.NETS)
    print(f"wrote {out}  ({n_parts} parts, {n_nets} nets, {len(wires)} pin stubs, "
          f"{len(ncs)} no-connects)")

if __name__ == "__main__":
    main()
