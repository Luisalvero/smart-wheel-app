#!/usr/bin/env python3
"""Draws the 16-pad wheel harness wiring diagram as an SVG.

Same pictorial style as the bench prototype sheet (revision A): boards as
labelled blocks, colour-coded wires, legend, notes and a title block. The
output is plain SVG, so it opens in Inkscape, draw.io or any browser.

    python3 wheel_harness_16pads.py            -> wheel_harness_16pads.svg
"""
from pathlib import Path

W, H = 2420, 1430
SANS = "Liberation Sans, Helvetica, Arial, sans-serif"
MONO = "JetBrainsMono NF, Liberation Mono, monospace"

C = {
    "bg": "#f6f7fa", "grid": "#e4e8ef", "edge": "#c9cfda", "ink": "#1c1e23",
    "muted": "#5b6270", "dark": "#1b1d22", "purple": "#5b2d8e",
    "blue": "#1f5fb4", "green": "#1a7f48", "panel": "#ffffff",
    "v12": "#d62828", "gnd": "#111417", "v5": "#e8871e", "v33": "#c2185b",
    "sda": "#1e6fd9", "scl": "#c99700", "usb": "#98a0ac",
}
S: list[str] = []
def add(x): S.append(x)
def esc(t): return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def box(x, y, w, h, fill, r=14, stroke="none", sw=2, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" '
        f'stroke="{stroke}" stroke-width="{sw}"{d}/>')

def text(x, y, t, size=13, fill=C["ink"], weight="normal", anchor="start", font=SANS):
    add(f'<text x="{x}" y="{y}" font-family="{font}" font-size="{size}" fill="{fill}" '
        f'font-weight="{weight}" text-anchor="{anchor}">{esc(t)}</text>')

def wire(pts, color, w=3):
    d = " ".join(("M" if i == 0 else "L") + f"{x} {y}" for i, (x, y) in enumerate(pts))
    add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{w}" '
        f'stroke-linecap="round" stroke-linejoin="round"/>')

def pin(x, y, color, r=5.5):
    add(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#fff" stroke="{color}" stroke-width="3"/>')

def junction(x, y, color):
    add(f'<circle cx="{x}" cy="{y}" r="6" fill="{color}"/>')

# ---------------------------------------------------------------- canvas ---
add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
    f'viewBox="0 0 {W} {H}" font-family="{SANS}">')
add(f'<rect width="{W}" height="{H}" fill="{C["bg"]}"/>')
add('<defs><pattern id="g" width="40" height="40" patternUnits="userSpaceOnUse">'
    f'<path d="M40 0H0V40" fill="none" stroke="{C["grid"]}" stroke-width="1"/></pattern></defs>')
add(f'<rect width="{W}" height="{H}" fill="url(#g)"/>')
add(f'<rect x="12" y="12" width="{W-24}" height="{H-24}" rx="8" fill="none" '
    f'stroke="{C["edge"]}" stroke-width="2"/>')

# ------------------------------------------------------------ power chain ---
box(46, 60, 230, 120, C["dark"])
text(66, 100, "12 V LiFePO4", 19, "#fff", "bold")
text(66, 126, "200 Ah, internal BMS", 12, "#c8ccd4")
text(66, 148, "10-14.6 V range", 12, "#c8ccd4")
text(286, 92, "+", 20, C["v12"], "bold")
text(286, 176, "-", 22, C["gnd"], "bold")

box(320, 78, 160, 54, C["panel"], 8, C["edge"])
add(f'<rect x="348" y="92" width="104" height="26" rx="4" fill="#f6e6c3" stroke="{C["edge"]}"/>')
text(400, 110, "10 A", 13, C["ink"], "bold", "middle", MONO)
text(400, 58, "Main fuse 10 A", 14, C["ink"], "bold", "middle")
text(400, 152, "within 15 cm of +", 11, C["muted"], anchor="middle")

box(524, 70, 150, 76, C["dark"], 10)
add(f'<rect x="576" y="88" width="46" height="40" rx="6" fill="{C["v12"]}"/>')
text(599, 58, "Battery switch", 14, C["ink"], "bold", "middle")

box(716, 56, 250, 140, C["dark"])
text(841, 84, "Fuse block", 17, "#fff", "bold", "middle")
add(f'<rect x="740" y="98" width="150" height="30" rx="5" fill="#f6e6c3"/>')
text(760, 119, "F1  5 A", 13, C["ink"], "bold", font=MONO)
text(900, 122, "Buck A", 11, "#c8ccd4")
add(f'<rect x="740" y="144" width="150" height="30" rx="5" fill="#dfe3ea"/>')
text(760, 165, "F2  2 A", 13, C["ink"], "bold", font=MONO)
text(900, 168, "Buck B", 11, "#c8ccd4")

box(716, 236, 250, 46, "#d7dbe3", 10, C["edge"])
text(841, 265, "negative bus bar", 14, C["ink"], "bold", "middle")

box(1012, 58, 250, 130, C["blue"])
text(1032, 92, "Buck A: 5.1 V, 5 A+", 16, "#fff", "bold")
text(1032, 120, "IN+   IN-", 12, "#dbe6f7", font=MONO)
text(1232, 120, "OUT+", 12, "#dbe6f7", anchor="end", font=MONO)
text(1232, 150, "OUT-", 12, "#dbe6f7", anchor="end", font=MONO)
text(1137, 208, "set 5.1-5.2 V before connecting the Pi", 11, C["muted"], anchor="middle")

box(1330, 44, 320, 150, C["green"])
text(1352, 82, "Raspberry Pi 5", 19, "#fff", "bold")
text(1352, 108, "USB-C power only", 12, "#d6efe0")
text(1352, 130, "BLE to ESP32 and phone", 12, "#d6efe0")
text(1352, 152, "Wi-Fi OFF (shared radio)", 12, "#d6efe0")
text(1352, 176, "40-pin GPIO: not used", 12, "#d6efe0")
wire([(1262, 96), (1330, 96)], C["usb"], 9)
text(1296, 82, "USB-C", 10, C["muted"], anchor="middle")

wire([(276, 104), (320, 104)], C["v12"])
wire([(480, 104), (524, 104)], C["v12"])
wire([(674, 104), (716, 104)], C["v12"])
wire([(890, 113), (990, 113), (990, 96), (1012, 96)], C["v12"])
wire([(890, 159), (1096, 159), (1096, 1360), (200, 1360), (200, 1120)], C["v12"])
wire([(276, 166), (296, 166), (296, 259), (716, 259)], C["gnd"])
wire([(966, 259), (1000, 259), (1000, 140), (1012, 140)], C["gnd"])
wire([(640, 282), (640, 1390), (250, 1390), (250, 1120)], C["gnd"])

# ------------------------------------------------------------------ ESP32 ---
EX, EY, EW, EH = 60, 400, 300, 560
box(EX, EY, EW, EH, C["dark"])
text(EX + EW / 2, EY + 46, "ESP32 DevKitC", 19, "#fff", "bold", "middle")
text(EX + EW / 2, EY + 70, "ESP32-WROOM-32, 38-pin", 12, "#c8ccd4", anchor="middle")
text(EX + EW / 2, EY + 92, "BLE to the Pi", 12, "#8fd3a8", anchor="middle")
PINS = [("3V3", C["v33"], EY + 150), ("5V", C["v5"], EY + 210), ("GND", C["gnd"], EY + 270),
        ("21 SDA", C["sda"], EY + 330), ("22 SCL", C["scl"], EY + 390)]
for name, col, y in PINS:
    pin(EX + EW, y, col)
    text(EX + EW - 20, y + 5, name, 14, "#fff", "bold", "end", MONO)
text(EX + EW / 2, EY + 500, "micro-USB", 12, "#c8ccd4", anchor="middle")
wire([(EX + EW / 2, EY + 510), (EX + EW / 2, 1010)], C["usb"], 9)

box(EX + 20, 1010, 260, 110, C["blue"])
text(EX + 36, 1046, "Buck B: 12 V -> 5 V USB", 14, "#fff", "bold")
text(EX + 36, 1070, "1 A or more (see note 5)", 11, "#dbe6f7")
text(EX + 36, 1096, "IN+ / IN- from fuse block F2", 11, "#dbe6f7")
text(EX + 150, 1142, "the USB cable doubles as the flashing cable", 11, C["muted"], anchor="middle")

# -------------------------------------------------------- muxes and pads ---
ROWS, ROW_H, ROW0 = 8, 74, 430
def mux(x, y, title, addr, strap):
    box(x, y, 210, ROWS * ROW_H - 14, C["purple"])
    text(x + 105, y + 40, title, 17, "#fff", "bold", "middle")
    text(x + 105, y + 64, addr, 13, "#e4d3f5", "bold", "middle", MONO)
    text(x + 105, y + 86, strap, 11, "#e4d3f5", anchor="middle")
    pin(x, y + 130, C["v33"]); text(x + 16, y + 135, "VIN", 12, "#fff", font=MONO)
    pin(x, y + 166, C["gnd"]); text(x + 16, y + 171, "GND", 12, "#fff", font=MONO)
    pin(x, y + 202, C["sda"]); text(x + 16, y + 207, "SDA", 12, "#fff", font=MONO)
    pin(x, y + 238, C["scl"]); text(x + 16, y + 243, "SCL", 12, "#fff", font=MONO)
    for i in range(ROWS):
        cy = ROW0 + i * ROW_H
        pin(x + 210, cy - 9, C["sda"]); pin(x + 210, cy + 13, C["scl"])
        text(x + 194, cy - 4, f"SD{i}", 11, "#e4d3f5", anchor="end", font=MONO)
        text(x + 194, cy + 18, f"SC{i}", 11, "#e4d3f5", anchor="end", font=MONO)

MAX, MBX, MY = 470, 1210, 400
mux(MAX, MY, "TCA9548A  A", "0x70", "A0-A2 -> GND")
mux(MBX, MY, "TCA9548A  B", "0x71", "A0 -> 3V3, A1-A2 -> GND")

PAD_W, PAD_H = 210, 56
def pads(x, first, mux_x, label):
    for i in range(ROWS):
        n = first + i
        cy = ROW0 + i * ROW_H
        box(x, cy - PAD_H / 2, PAD_W, PAD_H, C["purple"])
        text(x + 12, cy - 6, f"PAD {n:02d}   MAX30102", 12, "#fff", "bold")
        text(x + 12, cy + 14, f"0x57  {label} ch{i}", 11, "#e4d3f5", font=MONO)
        pin(x, cy - 12, C["sda"]); pin(x, cy + 10, C["scl"])
        wire([(mux_x + 210, cy - 9), (x - 26, cy - 9), (x - 26, cy - 12), (x, cy - 12)], C["sda"], 2.5)
        wire([(mux_x + 210, cy + 13), (x - 14, cy + 13), (x - 14, cy + 10), (x, cy + 10)], C["scl"], 2.5)
        # 5 V and ground stubs from the ring rails behind the pads
        wire([(x + PAD_W, cy - 12), (x + PAD_W + 26, cy - 12)], C["v5"], 2.5)
        wire([(x + PAD_W, cy + 10), (x + PAD_W + 40, cy + 10)], C["gnd"], 2.5)
        pin(x + PAD_W, cy - 12, C["v5"]); pin(x + PAD_W, cy + 10, C["gnd"])

pads(790, 1, MAX, "A")
pads(1540, 9, MBX, "B")

# power rails to the two pad columns (5 V orange, ground black)
for rx in (790 + PAD_W + 26, 1540 + PAD_W + 26):
    wire([(rx, ROW0 - 40), (rx, ROW0 + (ROWS - 1) * ROW_H + 30)], C["v5"])
for rx in (790 + PAD_W + 40, 1540 + PAD_W + 40):
    wire([(rx, ROW0 - 40), (rx, ROW0 + (ROWS - 1) * ROW_H + 46)], C["gnd"])
wire([(EX + EW, EY + 210), (410, EY + 210), (410, 346), (1796, 346), (1796, ROW0 - 40)], C["v5"])
junction(1026, 346, C["v5"])
wire([(1026, 346), (1026, ROW0 - 40)], C["v5"])
wire([(EX + EW, EY + 270), (386, EY + 270), (386, 376), (1810, 376), (1810, ROW0 - 40)], C["gnd"])
junction(1040, 376, C["gnd"])
wire([(1040, 376), (1040, ROW0 - 40)], C["gnd"])

# main I2C bus: ESP32 -> both multiplexers, plus the IMU.
# The bus runs in two clear vertical lanes to the left of mux A and along the
# bottom, so no wire crosses a board.
LANE_SDA, LANE_SCL = 420, 444
BUS_SDA, BUS_SCL = 1070, 1100
MUX_SDA_Y, MUX_SCL_Y = MY + 202, MY + 238
for lane, pin_y, mux_y, bus_y, col, lane_b in (
        (LANE_SDA, EY + 330, MUX_SDA_Y, BUS_SDA, C["sda"], MBX - 70),
        (LANE_SCL, EY + 390, MUX_SCL_Y, BUS_SCL, C["scl"], MBX - 46)):
    wire([(EX + EW, pin_y), (lane, pin_y)], col)          # ESP32 pin into the lane
    wire([(lane, mux_y), (lane, bus_y)], col)             # the lane itself
    wire([(lane, mux_y), (MAX, mux_y)], col)              # tap: multiplexer A
    wire([(lane, bus_y), (lane_b, bus_y)], col)           # along the bottom
    wire([(lane_b, bus_y), (lane_b, mux_y), (MBX, mux_y)], col)   # up into mux B
    junction(lane, pin_y, col)
    junction(lane, mux_y, col)

# 3.3 V and ground to both multiplexers, routed below the pads
wire([(EX + EW, EY + 150), (MAX - 70, EY + 150), (MAX - 70, MY + 130), (MAX, MY + 130)], C["v33"])
wire([(MAX - 70, MY + 130), (MAX - 70, 1300), (MBX - 100, 1300), (MBX - 100, MY + 130), (MBX, MY + 130)], C["v33"])
junction(MAX - 70, MY + 130, C["v33"])
wire([(EX + EW, EY + 270), (MAX - 100, EY + 270), (MAX - 100, MY + 166), (MAX, MY + 166)], C["gnd"])
wire([(MAX - 100, MY + 166), (MAX - 100, 1330), (MBX - 126, 1330), (MBX - 126, MY + 166), (MBX, MY + 166)], C["gnd"])
junction(MAX - 100, MY + 166, C["gnd"])

# IMU: on the main bus, no multiplexer channel needed
IMX, IMY = 690, 1150
box(IMX, IMY, 330, 120, "#11695f", 12, "#0c4a43", 2, "8 6")
text(IMX + 16, IMY + 34, "IMU (optional)", 15, "#fff", "bold")
text(IMX + 16, IMY + 58, "LSM6DSO, 0x6A", 12, "#bfe5df", font=MONO)
text(IMX + 16, IMY + 80, "on the main bus: its address does", 11, "#bfe5df")
text(IMX + 16, IMY + 100, "not clash, so no channel is used", 11, "#bfe5df")
junction(IMX + 130, BUS_SDA, C["sda"]); junction(IMX + 190, BUS_SCL, C["scl"])
wire([(IMX + 130, BUS_SDA), (IMX + 130, IMY)], C["sda"], 2.5)
wire([(IMX + 190, BUS_SCL), (IMX + 190, IMY)], C["scl"], 2.5)

# ------------------------------------------------- legend, notes, title ----
LX, LW = 1950, 440
box(LX, 380, LW, 250, C["panel"], 12, C["edge"])
text(LX + 20, 414, "Wire colours", 16, C["ink"], "bold")
LEG = [("12 V from battery (fused)", C["v12"]), ("Ground", C["gnd"]),
       ("5 V rail (pads)", C["v5"]), ("3.3 V from ESP32 (muxes)", C["v33"]),
       ("I2C data  SDA / SDn", C["sda"]), ("I2C clock SCL / SCn", C["scl"]),
       ("USB cable", C["usb"])]
for i, (name, col) in enumerate(LEG):
    y = 446 + i * 26
    wire([(LX + 20, y), (LX + 72, y)], col, 5)
    text(LX + 86, y + 5, name, 12)

box(LX, 656, LW, 470, C["panel"], 12, C["edge"])
text(LX + 20, 690, "Notes", 16, C["ink"], "bold")
NOTES = [
    "1  One multiplexer channel is on at a time. Every",
    "   MAX30102 is fixed at 0x57, which is why the pads",
    "   cannot share a bus directly.",
    "2  Firmware scans the pads for skin contact, streams",
    "   the pad with the best signal, and keeps a second",
    "   pad warm as standby; it takes over when the first",
    "   hand lets go. Only one pad streams at a time.",
    "3  Straps set the addresses: mux A 0x70 (A0-A2 to",
    "   GND), mux B 0x71 (A0 to 3V3).",
    "4  Pull-ups: one 4.7 kR pair per enabled branch; the",
    "   modules carry their own. On wheel-length wiring,",
    "   check the SDA/SCL rise time on a scope.",
    "5  Power: measure ONE pad at the firmware's LED",
    "   brightness, multiply by 16, add margin, then size",
    "   Buck B. Do not take the figure from a web page.",
    "6  Module I2C must idle near 3.3 V. A clone that idles",
    "   at 1.8 V needs 4.7 kR to 3V3 at its mux channel.",
    "7  Harness: keep channel runs short and twisted with",
    "   their ground; plan the steering-column crossing",
    "   (slip ring, or a loop with lock-to-lock slack).",
    "8  Shut the Pi down before the battery switch.",
]
for i, line in enumerate(NOTES):
    text(LX + 20, 716 + i * 20, line, 11.5, C["ink"] if line[0].isdigit() else C["muted"], font=MONO)

box(LX, 1150, LW, 230, C["panel"], 12, C["edge"])
text(LX + 20, 1186, "Biometric Steering Wheel", 18, C["ink"], "bold")
text(LX + 20, 1210, "Team 18, FIU Senior Design", 12, C["muted"])
add(f'<line x1="{LX}" y1="1226" x2="{LX+LW}" y2="1226" stroke="{C["edge"]}" stroke-width="2"/>')
text(LX + 20, 1252, "Wheel harness: 16 PPG pads, sheet 1 of 1", 13, C["ink"], "bold")
add(f'<line x1="{LX}" y1="1268" x2="{LX+LW}" y2="1268" stroke="{C["edge"]}" stroke-width="2"/>')
for i, (k, v) in enumerate([("Revision", "A"), ("Date", "2026-09-22"),
                            ("Status", "Not a medical device"), ("Grid", "not to scale")]):
    cx = LX + 20 + (i % 2) * 220
    cy = 1296 + (i // 2) * 44
    text(cx, cy, k, 10.5, C["muted"])
    text(cx, cy + 20, v, 13, C["ink"], "bold", font=MONO)

text(46, H - 26, "Pads 01-08 hang off multiplexer A, pads 09-16 off multiplexer B. "
     "Both share the ESP32's single I2C bus; the ESP32 selects which pad is visible.",
     12, C["muted"])
add("</svg>")
out = Path(__file__).with_suffix(".svg")
out.write_text("\n".join(S))
print("wrote", out)
