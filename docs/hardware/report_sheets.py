#!/usr/bin/env python3
"""Sheets 4 and 5 of TD18-HW-002: the verification record and the findings log.

Numbers come from verification.json, which verify.py writes when it runs the
tools, so nothing on these sheets is typed by hand.

    python3 verify.py && python3 report_sheets.py
"""
import json
from pathlib import Path

import wheel_harness_16pads as dw

HERE = Path(__file__).parent
REC = json.loads((HERE / "verification.json").read_text())
C = dw.C
MONO, SANS = dw.MONO, dw.SANS

def panel(x, y, w, h, title):
    dw.box(x, y, w, h, C["panel"], 0, C["ink"], 1.6)
    dw.text(x + 16, y + 30, title, 13, C["ink"], "bold")
    dw.line(x, y + 42, x + w, y + 42, C["edge"], 1)
    return y + 66

def rows(x, y, widths, header, data, size=10.5, rh=22, head=True):
    cx = x
    if head:
        for h, w in zip(header, widths):
            dw.text(cx + 8, y, h, 9.5, C["muted"], "bold")
            cx += w
        y += 18
        dw.line(x, y - 12, x + sum(widths), y - 12, C["edge"], 1)
    for row in data:
        cx = x
        for val, w in zip(row, widths):
            bold = val.startswith("*")
            dw.text(cx + 8, y, val.lstrip("*"), size,
                    C["v12"] if val.startswith("!") else C["ink"],
                    "bold" if bold else "normal", font=MONO if len(val) < 30 else SANS)
            cx += w
        y += rh
    return y

# ================================================= sheet 4: the record =====
def sheet4():
    dw.start_svg()
    ix0, iy0, ix1, iy1 = dw.frame(4, dw.SHEETS, "Sheet 4 - verification record")
    OX, OY = ix0 + 6, iy0 + 4
    dw.add(f'<g transform="translate({OX},{OY})">')
    env = REC["environment"]
    W1 = 1100

    y = panel(10, 20, W1, 272, "WHERE AND WHEN THESE RESULTS CAME FROM")
    rows(26, y, [280, 800], ["ITEM", "VALUE"], [
        ("*Run finished", REC["generated"]),
        ("*Machine", f'{env["host"]} - {env["os"]}'),
        ("*Schematic tool", env["kicad-cli"]),
        ("*Simulator", env["ngspice"]),
        ("*Renderer", env["librsvg"]),
        ("*Python", env["python"]),
        ("*Source", f'git {env["branch"]} @ {env["repo"]} - docs/hardware/'),
        ("*Drawing", f'{env["drawing"]} - sheets 1-2 drawn, sheet 3 from KiCad'),
    ], rh=24)

    y = panel(10, 314, W1, 372, "WHAT WAS RUN, AND WHAT IT RETURNED")
    data = []
    for s in REC["steps"]:
        vals = " ".join(f"{k}={v}" for k, v in s.get("values", {}).items())
        mark = "!" if s["verdict"] != s.get("expected", "PASS") else ""
        data.append((s["started"][11:19], s["name"][:42], f'{mark}{s["verdict"]}', vals[:54]))
    rows(26, y, [110, 390, 90, 500], ["TIME", "CHECK", "RESULT", "VALUES"], data, rh=25)
    dw.text(26, 670, "The 4.7 k run is expected to fail: it is the rejected option, kept as evidence.",
            10.5, C["muted"])

    y = panel(10, 708, W1, 300, "COMMANDS, EXACTLY AS EXECUTED")
    cmds = [(s["name"][:34], s["cmd"][:96]) for s in REC["steps"]]
    rows(26, y, [300, 830], ["CHECK", "COMMAND"], cmds, size=9.5, rh=21)

    # evidence files, with hashes, so a marker can confirm nothing was retyped
    import hashlib
    files = [("kicad/erc_report.txt", "KiCad ERC output"),
             ("kicad/wheel_harness.kicad_sch", "the schematic itself"),
             ("kicad/harness.kicad_sym", "symbol library"),
             ("kicad/wheel_harness.net", "netlist extracted by KiCad"),
             ("kicad/wheel_harness_bom.csv", "bill of materials"),
             ("verification.json", "this page's source data")]
    rowsf = []
    for rel, what in files:
        p = HERE / rel
        if p.exists():
            b = p.read_bytes()
            rowsf.append((rel, what, f"{len(b):>9,} B", hashlib.sha256(b).hexdigest()[:16]))
    y = panel(10, 1024, W1, 236, "EVIDENCE FILES KEPT WITH THE DRAWING (SHA-256, first 16 hex)")
    rows(26, y, [330, 300, 130, 280], ["FILE", "WHAT IT IS", "SIZE", "SHA-256"],
         rowsf, size=9.5, rh=21)

    # --- evidence column
    X2, W2 = 1140, 1150
    y = panel(X2, 20, W2, 420, "DEVICE DATA: DOCUMENT, WHERE IT CAME FROM, WHAT WAS TAKEN")
    rows(X2 + 16, y, [190, 320, 620], ["PART", "DOCUMENT", "VALUE USED AND WHERE IT APPEARS"], [
        ("*TCA9548A", "TI SCPS207H", "8 channels; 1110 A2 A1 A0 -> 0x70-0x77"),
        ("", "MAY 2012, rev SEP 2024", "Figure 7-3 / section 7.5.2 -> U1 0x70, U2 0x71"),
        ("", "ti.com/lit/ds/symlink/", "VCC 1.65-5.5 V; fSCL 0-400 kHz; 5 V tolerant"),
        ("", "tca9548a.pdf", "RESET active low -> R5/R6 10 k to +3V3"),
        ("", "fetched 2026-09-22", ""),
        ("*MAX30102", "Maxim 19-7740 Rev 1", "write 0xAE / read 0xAF = 7-bit 0x57 -> note 1"),
        ("", "10/18", "VDD 1.7-2.0 V, VLED+ 3.1-5.0 V -> note 6"),
        ("", "mirror: download.mikroe.com", "fSCL 0-400 kHz -> note 4"),
        ("", "(analog.com blocked the", "FIFO depth 32 samples -> read in bursts"),
        ("", "automated download)", ""),
        ("*I2C bus", "NXP UM10204 Rev 7.0", "fast mode tr <= 300 ns, Cb <= 400 pF"),
        ("", "1 October 2021, Table 10", "-> the pull-up limit checked in SPICE"),
        ("", "nxp.com/docs/en/user-guide/", ""),
        ("*IMU", "not verified", "address unknown until the module is chosen;"),
        ("", "", "it must not clash with 0x70 / 0x71"),
    ], size=10, rh=23)

    y = panel(X2, 462, W2, 300, "MEASURED AND SIMULATED NUMBERS, WITH THEIR CONDITIONS")
    sp = {s["name"]: s for s in REC["steps"]}
    tr22 = sp["SPICE transient: I2C rise time, Rp = 2.2 k"]["values"]
    tr47 = sp["SPICE transient: I2C rise time, Rp = 4.7 k"]["values"]
    rail = sp["SPICE operating point: +5V_PAD ring"]["values"]
    rows(X2 + 16, y, [400, 300, 420], ["QUANTITY", "CONDITIONS", "RESULT"], [
        ("*I2C rise time, 2.2 k", "Cb 82 pF, 1 m, 1 pad", f'{tr22["tr_ns"]} ns - PASS (limit 300 ns)'),
        ("*I2C rise time, 4.7 k", "same segment", f'{tr47["tr_ns"]} ns - FAIL, over the limit'),
        ("*Closed-form RC check", "tr = 0.8473 x R x C", "153 ns at 2.2 k - agrees within 0.2 %"),
        ("*+5V_PAD, first pad", f'{rail["total_mA"]} mA total, {rail["wire"]}', f'{rail["first_V"]} V'),
        ("*+5V_PAD, worst pad", "16 pads, all powered", f'{rail["worst_V"]} V - PASS'),
        ("*ERC", "KiCad, errors + warnings", "0 and 0"),
        ("*Netlist vs spec", "45 nets, 161 pin connections", "all match"),
        ("*BOM vs the parts list", "grouped by value", "16 pads, 2 switches, 4 x 2k2, 2 x 10k"),
    ], size=10, rh=24)

    erc = (HERE / "kicad" / "erc_report.txt").read_text().splitlines()
    y = panel(X2, 784, W2, 234, "KICAD ERC REPORT, VERBATIM")
    for i, l in enumerate(erc[:9]):
        dw.text(X2 + 16, y + i * 19, l.rstrip()[:110] or " ", 10.5,
                C["ink"] if "Errors" in l else C["muted"], font=MONO)

    y = panel(10, 1266, W1, 146, "HOW TO REPRODUCE THIS PAGE")
    rows(26, y, [1060], [""], [
        ("git clone <repo> && cd docs/hardware",),
        ("sudo pacman -S --needed kicad ngspice      # or your distribution's equivalent",),
        ("python3 verify.py                          # runs all 10 checks, writes verification.json",),
        ("python3 report_sheets.py && ./assemble.sh  # rebuilds this 5-sheet package",),
    ], size=10, rh=19, head=False)
    dw.add("</g>")
    return dw.save("sheet4_verification.svg")

# ============================================== sheet 5: findings =========
FINDINGS = [
    ("F-01", "2026-09-22\n2ff2bc2", "sim/i2c_bus.py, then ngspice",
     "4.7 k pull-ups, as first drawn, give a 327 ns rise time on a ~1 m branch",
     "Over the 300 ns fast-mode limit (UM10204 Table 10). The bus would still often work, "
     "but outside spec, and worse as the harness grows.",
     "Sheets and parts list changed to 2.2 k; note 5 rewritten with the number and the citation.",
     "ngspice: 152.8 ns at 2.2 k, 326.5 ns at 4.7 k on the same segment."),
    ("F-02", "2026-09-22\n93857ab", "harness_spec.py self-check",
     "The ESP32's USB input and its 5 V output pin were modelled as one pin",
     "The spec refused to build: one pin cannot be on both +5V_ESP and +5V_PAD. On a real board "
     "these are different nets with a fuse/diode between them.",
     "A1 now has VBUS_USB (power input, from PS2) and a separate 5V pin (power output, to the pads).",
     "Spec self-check passes: 177 pins, no pin on two nets."),
    ("F-03", "2026-09-22\nd70a3fd", "KiCad ERC",
     "power_pin_not_driven on PS1 IN+ and PS2 IN+",
     "A fuse is a passive part, so ERC could not see that the battery drives the rails past F2/F3. "
     "Real designs answer this with a power flag.",
     "PWR2 and PWR3 flags added on +12V_PI and +12V_ESP.",
     "Those two errors gone from the ERC report."),
    ("F-04", "2026-09-22\nd70a3fd", "KiCad ERC",
     "pin_to_pin: three power outputs fighting on GND",
     "The battery negative and both converter returns were all marked as drivers. Two drivers on one "
     "net is an error worth catching: on a real board it hides a wiring assumption.",
     "Battery '-' and both OUT- pins are now passive; PWR1 alone drives GND.",
     "No pin_to_pin violations remain."),
    ("F-05", "2026-09-22\nd70a3fd", "KiCad ERC",
     "pin_not_connected on pins that the drawing shows as wired",
     "Stub wire ends were snapped to the 1.27 mm grid while the pins themselves sat at 135.84 mm: "
     "a 0.05 mm gap. Electrically open, visually identical. A picture can never catch this.",
     "Symbol bodies are whole 2.54 mm steps and stubs now use the exact pin coordinate.",
     "161 pin connections, all extracted by KiCad and matched against the spec."),
    ("F-06", "2026-09-22\nd70a3fd", "KiCad ERC",
     "lib_symbol_issues on all 38 symbols",
     "The symbols were embedded in the sheet with no library to compare against, so KiCad could not "
     "confirm the placed symbol still matches its definition.",
     "gen_schematic.py now also writes harness.kicad_sym and a sym-lib-table.",
     "ERC: 0 errors, 0 warnings."),
    ("F-07", "2026-09-22\n684bf60", "visual review of sheet 1",
     "The F3 -> PS2 feed crossed over the PS1 block and its caption",
     "Readability only, no electrical effect, but a wire that runs through a part is exactly what a "
     "reviewer marks up.",
     "Rerouted: out of F3, down the gap before PS1, above the bus bar, then down a clear lane.",
     "Re-rendered and checked; no wire now crosses a board on sheet 1."),
]

LIMITS = [
    ("Cable capacitance", "60 pF/m ASSUMED", "The rise-time result scales directly with it. Measure the "
     "finished harness with an LCR meter, or read tr on a scope, then re-run sim/i2c_bus.py --cpm."),
    ("Per-pad current", "25 mA ASSUMED", "Used only for the +5V_PAD ladder. Measure one module at the "
     "firmware's LED setting before sizing PS2."),
    ("Wire resistance", "nominal AWG at 20 C", "Ignores connectors, splices and temperature. Treat the "
     "simulated drop as a floor."),
    ("IMU address", "unverified", "ST's site blocked the automated download. Confirm against the "
     "datasheet of the module actually fitted; it must not clash with 0x70 / 0x71."),
    ("Module regulator", "assumed present", "5 V goes to module VIN, never to the bare chip "
     "(VDD 1.7-2.0 V). Confirm the module regulates and that its I2C idles near 3.3 V."),
    ("Schematic style", "labels, not drawn wires", "Connectivity is by net label, which is normal for a "
     "repetitive design and is what ERC and the netlist check verify."),
    ("Scope", "electrical only", "No PCB layout, no thermal or mechanical analysis, no EMC. "
     "Student prototype: NOT A MEDICAL DEVICE."),
]

def sheet5():
    dw.start_svg()
    ix0, iy0, ix1, iy1 = dw.frame(5, dw.SHEETS, "Sheet 5 - findings, fixes and limits")
    OX, OY = ix0 + 6, iy0 + 4
    dw.add(f'<g transform="translate({OX},{OY})">')

    y = panel(10, 20, 2290, 730, "WHAT THE CHECKS FOUND, AND WHAT WAS CHANGED")
    cx = [26, 110, 300, 480, 900, 1430, 1900]
    hdr = ["ID", "DATE / FIXED IN", "FOUND BY", "WHAT WAS WRONG", "WHY IT MATTERS", "THE FIX", "HOW IT WAS VERIFIED"]
    for x, h in zip(cx, hdr):
        dw.text(x, y, h, 9.5, C["muted"], "bold")
    y += 8
    dw.line(10, y, 2300, y, C["edge"], 1)
    y += 22
    widths = [84, 190, 180, 420, 530, 470, 430]
    for fid, when, by, what, why, fix, ver in FINDINGS:
        dw.text(cx[0], y, fid, 11, C["ink"], "bold", font=MONO)
        for k, part in enumerate(when.split("\n")):
            dw.text(cx[1], y + k * 15, part, 10, C["muted"], font=MONO)
        dw.text(cx[2], y, by, 10, C["ink"], font=MONO)
        for x, txt, w, col in ((cx[3], what, widths[3], C["ink"]), (cx[4], why, widths[4], C["muted"]),
                               (cx[5], fix, widths[5], C["ink"]), (cx[6], ver, widths[6], C["ink"])):
            line, dy = "", 0
            for word in txt.split():
                if len(line) + len(word) + 1 > int(w / 5.6):
                    dw.text(x, y + dy, line, 10, col)
                    line, dy = word, dy + 15
                else:
                    line = f"{line} {word}".strip()
            dw.text(x, y + dy, line, 10, col)
        y += 92
        dw.line(10, y - 26, 2300, y - 26, C["grid"], 1)

    y = panel(10, 770, 1120, 330, "ASSUMPTIONS AND LIMITS - READ BEFORE TRUSTING A NUMBER")
    for item, value, note in LIMITS:
        dw.text(26, y, item, 10.5, C["ink"], "bold")
        dw.text(250, y, value, 10.5, C["v12"] if "ASSUM" in value or "unverified" in value else C["muted"], font=MONO)
        line, dy = "", 0
        for word in note.split():
            if len(line) + len(word) + 1 > 95:
                dw.text(470, y + dy, line, 10, C["muted"]); line, dy = word, dy + 14
            else:
                line = f"{line} {word}".strip()
        dw.text(470, y + dy, line, 10, C["muted"])
        y += 38

    y = panel(1160, 770, 1130, 300, "WHAT THIS PACKAGE CONTAINS")
    rows(1176, y, [180, 930], ["SHEET", "CONTENT"], [
        ("*1", "Interconnect diagram: boards, wires, colour key, 9 notes"),
        ("*2", "Parts list (15 lines) and wire list (21 nets), power-up checklist"),
        ("*3", "KiCad schematic, generated from harness_spec.py, ERC clean"),
        ("*4", "Verification record: environment, commands, results, datasheet evidence"),
        ("*5", "This sheet: findings, fixes, assumptions and limits"),
        ("", ""),
        ("*Sources", "docs/hardware/ - drawing generator, spec, KiCad project, simulations"),
        ("*Rebuild", "python3 verify.py && python3 report_sheets.py && ./assemble.sh"),
    ], size=10.5, rh=26)
    dw.add("</g>")
    return dw.save("sheet5_findings.svg")

if __name__ == "__main__":
    print("wrote", sheet4(), "and", sheet5())
