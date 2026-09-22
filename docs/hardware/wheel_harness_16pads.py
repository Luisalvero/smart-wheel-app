#!/usr/bin/env python3
"""Team 18 drawing TD18-HW-002: 16-pad wheel harness, 2 sheets.

Sheet 1  interconnect diagram (boards, wires, notes)
Sheet 2  parts list and wire list

Every device fact on the sheets is taken from the primary datasheet and cited
there:
  TCA9548A  TI SCPS207H, MAY 2012 - REVISED SEPTEMBER 2024
            8 channels; address byte 1110 A2 A1 A0 (0x70-0x77, Figure 7-3,
            SS7.5.2); VCC 1.65-5.5 V; fSCL 0-400 kHz; active-low RESET,
            tie to VCC through a pull-up when unused; 5 V tolerant I/O.
  MAX30102  Maxim 19-7740; Rev 1; 10/18
            I2C write address 0xAE, read 0xAF (7-bit 0x57); VDD 1.7-2.0 V
            (1.8 typ); VLED+ 3.1-5.0 V (3.3 typ); fSCL 0-400 kHz; FIFO depth
            32 samples.

    python3 wheel_harness_16pads.py     -> .svg (sheet 1), _sheet2.svg, .pdf
"""
import subprocess
from pathlib import Path

W, H = 2448, 1584                      # ANSI B proportions (17 x 11)
M = 26                                 # outer margin
FR = 44                                # frame band (zone letters/numbers)
SANS = "Liberation Sans, Helvetica, Arial, sans-serif"
MONO = "JetBrainsMono NF, Liberation Mono, monospace"

C = {
    "bg": "#f6f7fa", "grid": "#e4e8ef", "edge": "#c9cfda", "ink": "#1c1e23",
    "muted": "#5b6270", "dark": "#1b1d22", "purple": "#5b2d8e",
    "blue": "#1f5fb4", "green": "#1a7f48", "teal": "#11695f", "panel": "#ffffff",
    "v12": "#d62828", "gnd": "#111417", "v5": "#e8871e", "v33": "#c2185b",
    "sda": "#1e6fd9", "scl": "#c99700", "usb": "#98a0ac",
}

TITLE = "Biometric Steering Wheel - 16 PPG pad harness"
DWG, REV, DATE = "TD18-HW-002", "A", "2026-09-22"
ORG = "Team 18 - FIU Senior Design"

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

def line(x1, y1, x2, y2, col=C["edge"], w=2):
    add(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{col}" stroke-width="{w}"/>')

def wire(pts, color, w=3):
    d = " ".join(("M" if i == 0 else "L") + f"{x} {y}" for i, (x, y) in enumerate(pts))
    add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{w}" '
        f'stroke-linecap="round" stroke-linejoin="round"/>')

def pin(x, y, color, r=5.5):
    add(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#fff" stroke="{color}" stroke-width="3"/>')

def junction(x, y, color):
    add(f'<circle cx="{x}" cy="{y}" r="6" fill="{color}"/>')

# ------------------------------------------------------- sheet furniture ---
def start_svg():
    S.clear()
    add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
        f'viewBox="0 0 {W} {H}" font-family="{SANS}">')
    add(f'<rect width="{W}" height="{H}" fill="{C["bg"]}"/>')
    add('<defs><pattern id="g" width="40" height="40" patternUnits="userSpaceOnUse">'
        f'<path d="M40 0H0V40" fill="none" stroke="{C["grid"]}" stroke-width="1"/></pattern></defs>')
    add(f'<rect width="{W}" height="{H}" fill="url(#g)"/>')

def frame(sheet: int, of: int, subtitle: str):
    """Drawing frame with zone markers and the title block, ISO/ANSI style."""
    x0, y0, x1, y1 = M, M, W - M, H - M
    add(f'<rect x="{x0}" y="{y0}" width="{x1-x0}" height="{y1-y0}" fill="none" '
        f'stroke="{C["ink"]}" stroke-width="2.5"/>')
    ix0, iy0, ix1, iy1 = x0 + FR, y0 + FR, x1 - FR, y1 - FR
    add(f'<rect x="{ix0}" y="{iy0}" width="{ix1-ix0}" height="{iy1-iy0}" fill="none" '
        f'stroke="{C["ink"]}" stroke-width="1.6"/>')
    cols, rows = 8, 6
    cw, rh = (ix1 - ix0) / cols, (iy1 - iy0) / rows
    for i in range(cols):
        cx = ix0 + cw * (i + 0.5)
        text(cx, y0 + 30, str(i + 1), 15, C["ink"], "bold", "middle", MONO)
        text(cx, y1 - 14, str(i + 1), 15, C["ink"], "bold", "middle", MONO)
        if i:
            line(ix0 + cw * i, y0, ix0 + cw * i, iy0, C["ink"], 1.2)
            line(ix0 + cw * i, iy1, ix0 + cw * i, y1, C["ink"], 1.2)
    for j in range(rows):
        cy = iy0 + rh * (j + 0.5) + 6
        letter = "ABCDEF"[j]
        text(x0 + 22, cy, letter, 15, C["ink"], "bold", "middle", MONO)
        text(x1 - 22, cy, letter, 15, C["ink"], "bold", "middle", MONO)
        if j:
            line(x0, iy0 + rh * j, ix0, iy0 + rh * j, C["ink"], 1.2)
            line(ix1, iy0 + rh * j, x1, iy0 + rh * j, C["ink"], 1.2)
    # title block, bottom right inside the frame
    tw, th = 760, 150
    tx, ty = ix1 - tw, iy1 - th
    box(tx, ty, tw, th, C["panel"], 0, C["ink"], 1.6)
    line(tx, ty + 52, tx + tw, ty + 52, C["ink"], 1.2)
    line(tx, ty + 100, tx + tw, ty + 100, C["ink"], 1.2)
    for vx in (tx + 300, tx + 470, tx + 600):
        line(vx, ty + 52, vx, ty + th, C["ink"], 1.2)
    text(tx + 14, ty + 24, ORG, 12, C["muted"])
    text(tx + 14, ty + 44, TITLE, 16, C["ink"], "bold")
    text(tx + 14, ty + 70, "SUBTITLE", 9, C["muted"])
    text(tx + 14, ty + 90, subtitle, 13, C["ink"], "bold")
    cells = [(tx + 314, "DRAWING No.", DWG), (tx + 484, "REV", REV),
             (tx + 614, "SHEET", f"{sheet} of {of}")]
    for cx, k, v in cells:
        text(cx, ty + 70, k, 9, C["muted"])
        text(cx, ty + 90, v, 13, C["ink"], "bold", font=MONO)
    for cx, k, v in ((tx + 14, "DRAWN", "Team 18"), (tx + 314, "DATE", DATE),
                     (tx + 484, "SCALE", "NTS"), (tx + 614, "SIZE", "B")):
        text(cx, ty + 118, k, 9, C["muted"])
        text(cx, ty + 138, v, 12, C["ink"], font=MONO)
    # revision block, above the title block
    rw, rh2 = 760, 86
    rx, ry = ix1 - rw, ty - rh2 - 12
    box(rx, ry, rw, rh2, C["panel"], 0, C["ink"], 1.6)
    line(rx, ry + 28, rx + rw, ry + 28, C["ink"], 1.2)
    for vx in (rx + 70, rx + 500, rx + 630):
        line(vx, ry, vx, ry + rh2, C["ink"], 1.2)
    for cx, k in ((rx + 12, "REV"), (rx + 82, "DESCRIPTION"), (rx + 512, "DATE"), (rx + 642, "BY")):
        text(cx, ry + 19, k, 10, C["muted"], "bold")
    for cx, v in ((rx + 12, "A"), (rx + 82, "Initial release - 16 pads, two multiplexers"),
                  (rx + 512, DATE), (rx + 642, "Team 18")):
        text(cx, ry + 54, v, 12, C["ink"], font=MONO if cx in (rx + 12, rx + 512) else SANS)
    text(ix0 + 10, iy1 - 14, "NOT A MEDICAL DEVICE - student prototype. Interconnect drawing: "
         "not to scale, not a PCB layout.", 11, C["muted"])
    return ix0, iy0, ix1, iy1

def save(name: str):
    add("</svg>")
    p = Path(__file__).parent / name
    p.write_text("\n".join(S))
    return p

# =============================================== sheet 1: interconnect ======
def sheet1():
    start_svg()
    ix0, iy0, ix1, iy1 = frame(1, 2, "Sheet 1 - interconnect diagram")
    OX, OY = ix0 + 6, iy0 + 4          # content origin inside the frame
    add(f'<g transform="translate({OX},{OY})">')

    def T(x, y): return (x, y)

    # ---------------------------------------------------------- power row --
    box(20, 30, 230, 120, C["dark"])
    text(40, 70, "12 V LiFePO4", 19, "#fff", "bold")
    text(40, 96, "BT1  200 Ah, internal BMS", 12, "#c8ccd4", font=MONO)
    text(40, 118, "10-14.6 V range", 12, "#c8ccd4")
    text(260, 62, "+", 20, C["v12"], "bold")
    text(260, 146, "-", 22, C["gnd"], "bold")

    box(294, 48, 160, 54, C["panel"], 8, C["edge"])
    add(f'<rect x="322" y="62" width="104" height="26" rx="4" fill="#f6e6c3" stroke="{C["edge"]}"/>')
    text(374, 80, "10 A", 13, C["ink"], "bold", "middle", MONO)
    text(374, 28, "F1  main fuse 10 A", 14, C["ink"], "bold", "middle")
    text(374, 122, "within 15 cm of BT1 +", 11, C["muted"], anchor="middle")

    box(498, 40, 150, 76, C["dark"], 10)
    add(f'<rect x="550" y="58" width="46" height="40" rx="6" fill="{C["v12"]}"/>')
    text(573, 28, "SW1  battery switch", 14, C["ink"], "bold", "middle")

    box(690, 26, 250, 140, C["dark"])
    text(815, 54, "TB1  fuse block", 17, "#fff", "bold", "middle")
    add('<rect x="714" y="68" width="150" height="30" rx="5" fill="#f6e6c3"/>')
    text(734, 89, "F2  5 A", 13, C["ink"], "bold", font=MONO)
    text(874, 92, "to PS1", 11, "#c8ccd4")
    add('<rect x="714" y="114" width="150" height="30" rx="5" fill="#dfe3ea"/>')
    text(734, 135, "F3  2 A", 13, C["ink"], "bold", font=MONO)
    text(874, 138, "to PS2", 11, "#c8ccd4")

    box(690, 206, 250, 46, "#d7dbe3", 10, C["edge"])
    text(815, 235, "TB2  negative bus bar", 14, C["ink"], "bold", "middle")

    box(986, 28, 250, 130, C["blue"])
    text(1006, 62, "PS1  buck 5.1 V / 5 A+", 15, "#fff", "bold")
    text(1006, 90, "IN+   IN-", 12, "#dbe6f7", font=MONO)
    text(1206, 90, "OUT+", 12, "#dbe6f7", anchor="end", font=MONO)
    text(1206, 120, "OUT-", 12, "#dbe6f7", anchor="end", font=MONO)
    text(1111, 178, "set 5.1-5.2 V off-load before connecting A2", 11, C["muted"], anchor="middle")

    box(1304, 14, 320, 150, C["green"])
    text(1326, 52, "A2  Raspberry Pi 5", 18, "#fff", "bold")
    text(1326, 78, "USB-C power only", 12, "#d6efe0")
    text(1326, 100, "BLE to A1 and to the phone", 12, "#d6efe0")
    text(1326, 122, "Wi-Fi OFF (shared radio, note 9)", 12, "#d6efe0")
    text(1326, 146, "40-pin GPIO: not used", 12, "#d6efe0")
    wire([(1236, 66), (1304, 66)], C["usb"], 9)
    text(1270, 52, "USB-C", 10, C["muted"], anchor="middle")

    wire([(250, 74), (294, 74)], C["v12"])
    wire([(454, 74), (498, 74)], C["v12"])
    wire([(648, 74), (690, 74)], C["v12"])
    wire([(864, 83), (964, 83), (964, 66), (986, 66)], C["v12"])
    wire([(864, 129), (1070, 129), (1070, 1300), (174, 1300), (174, 1090)], C["v12"])
    wire([(250, 136), (270, 136), (270, 229), (690, 229)], C["gnd"])
    wire([(940, 229), (974, 229), (974, 110), (986, 110)], C["gnd"])
    wire([(614, 252), (614, 1330), (224, 1330), (224, 1090)], C["gnd"])

    # --------------------------------------------------------------- A1 ----
    EX, EY, EW, EH = 34, 370, 300, 560
    box(EX, EY, EW, EH, C["dark"])
    text(EX + EW / 2, EY + 46, "A1  ESP32 DevKitC", 18, "#fff", "bold", "middle")
    text(EX + EW / 2, EY + 70, "ESP32-WROOM-32, 38-pin", 12, "#c8ccd4", anchor="middle")
    text(EX + EW / 2, EY + 92, "BLE to A2", 12, "#8fd3a8", anchor="middle")
    PINS = [("3V3", C["v33"], EY + 150), ("5V", C["v5"], EY + 210), ("GND", C["gnd"], EY + 270),
            ("IO21 SDA", C["sda"], EY + 330), ("IO22 SCL", C["scl"], EY + 390)]
    for name, col, y in PINS:
        pin(EX + EW, y, col)
        text(EX + EW - 20, y + 5, name, 13, "#fff", "bold", "end", MONO)
    text(EX + EW / 2, EY + 500, "micro-USB", 12, "#c8ccd4", anchor="middle")
    wire([(EX + EW / 2, EY + 510), (EX + EW / 2, 980)], C["usb"], 9)

    box(EX - 6, 980, 266, 110, C["blue"])
    text(EX + 10, 1016, "PS2  buck 12 V -> 5 V USB", 14, "#fff", "bold")
    text(EX + 10, 1040, "1 A or more - size by note 5", 11, "#dbe6f7")
    text(EX + 10, 1066, "IN+ / IN- from TB1 F3", 11, "#dbe6f7", font=MONO)
    text(EX + 124, 1112, "the USB cable doubles as the flashing cable", 11, C["muted"], anchor="middle")

    # -------------------------------------------------- multiplexers/pads --
    ROWS, ROW_H, ROW0 = 8, 74, 400
    MAX_, MBX, MY = 444, 1184, 370
    def mux(x, y, ref, addr, strap):
        box(x, y, 210, ROWS * ROW_H - 14, C["purple"])
        text(x + 105, y + 38, ref, 17, "#fff", "bold", "middle")
        text(x + 105, y + 60, "TCA9548A", 13, "#e4d3f5", "bold", "middle", MONO)
        text(x + 105, y + 82, addr, 13, "#e4d3f5", "bold", "middle", MONO)
        text(x + 105, y + 102, strap, 10.5, "#e4d3f5", anchor="middle")
        pin(x, y + 152, C["v33"]); text(x + 16, y + 157, "VIN", 12, "#fff", font=MONO)
        pin(x, y + 188, C["gnd"]); text(x + 16, y + 193, "GND", 12, "#fff", font=MONO)
        pin(x, y + 224, C["sda"]); text(x + 16, y + 229, "SDA", 12, "#fff", font=MONO)
        pin(x, y + 260, C["scl"]); text(x + 16, y + 265, "SCL", 12, "#fff", font=MONO)
        for i in range(ROWS):
            cy = ROW0 + i * ROW_H
            pin(x + 210, cy - 9, C["sda"]); pin(x + 210, cy + 13, C["scl"])
            text(x + 194, cy - 4, f"SD{i}", 11, "#e4d3f5", anchor="end", font=MONO)
            text(x + 194, cy + 18, f"SC{i}", 11, "#e4d3f5", anchor="end", font=MONO)
    mux(MAX_, MY, "U1", "0x70", "A0-A2 -> GND")
    mux(MBX, MY, "U2", "0x71", "A0 -> +3V3, A1-A2 -> GND")

    PAD_W, PAD_H = 210, 56
    def pads(x, first, mux_x, label):
        for i in range(ROWS):
            n = first + i
            cy = ROW0 + i * ROW_H
            box(x, cy - PAD_H / 2, PAD_W, PAD_H, C["purple"])
            text(x + 12, cy - 6, f"MOD{n:02d}  MAX30102", 12, "#fff", "bold")
            text(x + 12, cy + 14, f"0x57   {label} ch{i}", 11, "#e4d3f5", font=MONO)
            pin(x, cy - 12, C["sda"]); pin(x, cy + 10, C["scl"])
            wire([(mux_x + 210, cy - 9), (x - 26, cy - 9), (x - 26, cy - 12), (x, cy - 12)], C["sda"], 2.5)
            wire([(mux_x + 210, cy + 13), (x - 14, cy + 13), (x - 14, cy + 10), (x, cy + 10)], C["scl"], 2.5)
            wire([(x + PAD_W, cy - 12), (x + PAD_W + 26, cy - 12)], C["v5"], 2.5)
            wire([(x + PAD_W, cy + 10), (x + PAD_W + 40, cy + 10)], C["gnd"], 2.5)
            pin(x + PAD_W, cy - 12, C["v5"]); pin(x + PAD_W, cy + 10, C["gnd"])
    PC1, PC2 = 764, 1480
    pads(PC1, 1, MAX_, "U1")
    pads(PC2, 9, MBX, "U2")
    text(PC1 + PAD_W / 2, ROW0 - 86, "PADS 01-08", 12, C["muted"], "bold", "middle")
    text(PC2 + PAD_W / 2, ROW0 - 86, "PADS 09-16", 12, C["muted"], "bold", "middle")

    for rx in (PC1 + PAD_W + 26, PC2 + PAD_W + 26):
        wire([(rx, ROW0 - 40), (rx, ROW0 + (ROWS - 1) * ROW_H + 30)], C["v5"])
    for rx in (PC1 + PAD_W + 40, PC2 + PAD_W + 40):
        wire([(rx, ROW0 - 40), (rx, ROW0 + (ROWS - 1) * ROW_H + 46)], C["gnd"])
    wire([(EX + EW, EY + 210), (384, EY + 210), (384, 316), (PC2 + PAD_W + 26, 316),
          (PC2 + PAD_W + 26, ROW0 - 40)], C["v5"])
    junction(PC1 + PAD_W + 26, 316, C["v5"])
    wire([(PC1 + PAD_W + 26, 316), (PC1 + PAD_W + 26, ROW0 - 40)], C["v5"])
    wire([(EX + EW, EY + 270), (360, EY + 270), (360, 346), (PC2 + PAD_W + 40, 346),
          (PC2 + PAD_W + 40, ROW0 - 40)], C["gnd"])
    junction(PC1 + PAD_W + 40, 346, C["gnd"])
    wire([(PC1 + PAD_W + 40, 346), (PC1 + PAD_W + 40, ROW0 - 40)], C["gnd"])

    # main bus in two clear lanes, no wire crosses a board
    LANE_SDA, LANE_SCL = 394, 418
    BUS_SDA, BUS_SCL = 1040, 1070
    MUX_SDA_Y, MUX_SCL_Y = MY + 224, MY + 260
    for lane, pin_y, mux_y, bus_y, col, lane_b in (
            (LANE_SDA, EY + 330, MUX_SDA_Y, BUS_SDA, C["sda"], MBX - 70),
            (LANE_SCL, EY + 390, MUX_SCL_Y, BUS_SCL, C["scl"], MBX - 46)):
        wire([(EX + EW, pin_y), (lane, pin_y)], col)
        wire([(lane, mux_y), (lane, bus_y)], col)
        wire([(lane, mux_y), (MAX_, mux_y)], col)
        wire([(lane, bus_y), (lane_b, bus_y)], col)
        wire([(lane_b, bus_y), (lane_b, mux_y), (MBX, mux_y)], col)
        junction(lane, pin_y, col)
        junction(lane, mux_y, col)
    text(560, BUS_SDA - 10, "SDA_MAIN  (<= 400 kHz, note 4)", 11, C["sda"], "bold")
    text(560, BUS_SCL + 24, "SCL_MAIN", 11, C["scl"], "bold")

    wire([(EX + EW, EY + 150), (MAX_ - 70, EY + 150), (MAX_ - 70, MY + 152), (MAX_, MY + 152)], C["v33"])
    wire([(MAX_ - 70, MY + 152), (MAX_ - 70, 1270), (MBX - 100, 1270), (MBX - 100, MY + 152), (MBX, MY + 152)], C["v33"])
    junction(MAX_ - 70, MY + 152, C["v33"])
    wire([(EX + EW, EY + 270), (MAX_ - 100, EY + 270), (MAX_ - 100, MY + 188), (MAX_, MY + 188)], C["gnd"])
    wire([(MAX_ - 100, MY + 188), (MAX_ - 100, 1240), (MBX - 126, 1240), (MBX - 126, MY + 188), (MBX, MY + 188)], C["gnd"])
    junction(MAX_ - 100, MY + 188, C["gnd"])

    IMX, IMY = 664, 1120
    box(IMX, IMY, 330, 120, C["teal"], 12, "#0c4a43", 2, "8 6")
    text(IMX + 16, IMY + 32, "U3  IMU (optional)", 15, "#fff", "bold")
    text(IMX + 16, IMY + 56, "on SDA_MAIN / SCL_MAIN", 11.5, "#bfe5df")
    text(IMX + 16, IMY + 78, "address must not clash with", 11, "#bfe5df")
    text(IMX + 16, IMY + 98, "0x70 / 0x71 - check its datasheet", 11, "#bfe5df")
    junction(IMX + 130, BUS_SDA, C["sda"]); junction(IMX + 190, BUS_SCL, C["scl"])
    wire([(IMX + 130, BUS_SDA), (IMX + 130, IMY)], C["sda"], 2.5)
    wire([(IMX + 190, BUS_SCL), (IMX + 190, IMY)], C["scl"], 2.5)

    # ------------------------------------------------- legend and notes ----
    LX, LW = 1836, 440
    box(LX, 350, LW, 240, C["panel"], 10, C["ink"], 1.6)
    text(LX + 18, 382, "WIRE COLOURS", 13, C["ink"], "bold")
    LEG = [("+12 V, fused", C["v12"]), ("GND", C["gnd"]), ("+5V_PAD rail", C["v5"]),
           ("+3V3 (multiplexers)", C["v33"]), ("SDA / SDn", C["sda"]),
           ("SCL / SCn", C["scl"]), ("USB cable", C["usb"])]
    for i, (name, col) in enumerate(LEG):
        y = 412 + i * 25
        wire([(LX + 18, y), (LX + 66, y)], col, 5)
        text(LX + 80, y + 5, name, 12)

    box(LX, 606, LW, 520, C["panel"], 10, C["ink"], 1.6)
    text(LX + 18, 638, "NOTES", 13, C["ink"], "bold")
    NOTES = [
        "1  Every MAX30102 answers to one fixed address",
        "   (write 0xAE / read 0xAF, i.e. 7-bit 0x57), so the",
        "   pads cannot share a bus. U1/U2 give each pad its",
        "   own segment.  [MAX30102, 19-7740 Rev 1, 10/18]",
        "2  U1/U2 address = 1110 A2 A1 A0, so 0x70-0x77;",
        "   strapped 0x70 and 0x71 here. VCC 1.65-5.5 V.",
        "   [TCA9548A, TI SCPS207H, Fig 7-3 / SS7.5.2]",
        "3  RESET is active low: tie to +3V3 through a",
        "   pull-up when unused.  [SCPS207H, pin table]",
        "4  Bus speed <= 400 kHz: both parts are rated",
        "   0-400 kHz.  [SCPS207H; 19-7740 Rev 1]",
        "5  Pull-ups: one 4.7 k pair per ENABLED segment;",
        "   the modules carry their own. Check SDA/SCL rise",
        "   time on a scope once the harness length is set.",
        "6  +5V_PAD goes to the MODULE input, never to the",
        "   bare chip: MAX30102 VDD is 1.7-2.0 V and VLED+",
        "   3.1-5.0 V; the module regulates. Confirm the",
        "   module's I2C idles near 3.3 V, not 1.8 V.",
        "7  Power budget by MEASUREMENT: measure one pad at",
        "   the firmware's LED setting, multiply by 16, add",
        "   margin, then size PS2. Do not use a web figure.",
        "8  One segment is enabled at a time. Firmware scans",
        "   for skin contact, streams the best pad and keeps",
        "   a second as standby for handover.",
        "9  A2 keeps Wi-Fi off: its Wi-Fi and Bluetooth share",
        "   one radio, and the BLE link fails with Wi-Fi on.",
    ]
    for i, l in enumerate(NOTES):
        text(LX + 18, 662 + i * 17, l, 10.5, C["ink"] if l[0].isdigit() else C["muted"], font=MONO)

    text(20, 1358, "Pads 01-08 hang off U1, pads 09-16 off U2. Both multiplexers and the IMU share "
         "the single I2C bus from A1; the ESP32 selects which pad is visible. Wire list: sheet 2.",
         12, C["muted"])
    add("</g>")
    return save("wheel_harness_16pads.svg")

# ================================================ sheet 2: lists ============
def sheet2():
    start_svg()
    ix0, iy0, ix1, iy1 = frame(2, 2, "Sheet 2 - parts list and wire list")
    OX, OY = ix0 + 6, iy0 + 4
    add(f'<g transform="translate({OX},{OY})">')

    def table(x, y, w, title, cols, rows, widths, row_h=26):
        text(x, y - 12, title, 15, C["ink"], "bold")
        head_h = 30
        h = head_h + row_h * len(rows)
        box(x, y, w, h, C["panel"], 0, C["ink"], 1.6)
        line(x, y + head_h, x + w, y + head_h, C["ink"], 1.6)
        cx = x
        for cw in widths[:-1]:
            cx += cw
            line(cx, y, cx, y + h, C["ink"], 1)
        cx = x
        for name, cw in zip(cols, widths):
            text(cx + 10, y + 20, name, 11, C["muted"], "bold")
            cx += cw
        for r, row in enumerate(rows):
            ry = y + head_h + row_h * (r + 1) - 8
            if r:
                line(x, y + head_h + row_h * r, x + w, y + head_h + row_h * r, C["edge"], 1)
            cx = x
            for val, cw in zip(row, widths):
                text(cx + 10, ry, val, 11.5, C["ink"], font=MONO if len(val) < 22 else SANS)
                cx += cw
        return y + h

    BOM_COLS = ["REF", "QTY", "DESCRIPTION", "KEY RATINGS / NOTES"]
    BOM_W = [90, 60, 470, 500]
    BOM = [
        ("BT1", "1", "12 V LiFePO4 battery, 200 Ah, internal BMS", "10-14.6 V working range"),
        ("F1", "1", "Fuse + holder, 10 A", "within 15 cm of BT1 +"),
        ("SW1", "1", "Battery master switch", "disconnects the whole system"),
        ("TB1", "1", "Fused distribution block, 2 ways", "F2 5 A -> PS1, F3 2 A -> PS2"),
        ("TB2", "1", "Negative bus bar", "single return point"),
        ("PS1", "1", "Buck converter 12 V -> 5.1 V, 5 A or more", "set off-load before connecting A2"),
        ("PS2", "1", "Buck converter 12 V -> 5 V USB", "1 A or more; size by note 5, sheet 1"),
        ("A1", "1", "ESP32-WROOM-32 DevKitC, 38-pin", "I2C on IO21/IO22; BLE to A2"),
        ("A2", "1", "Raspberry Pi 5", "USB-C power only; Wi-Fi off"),
        ("U1, U2", "2", "TCA9548A 8-channel I2C switch module", "0x70 / 0x71; VCC 1.65-5.5 V; 400 kHz"),
        ("MOD01-16", "16", "MAX30102 pulse-oximetry module", "0x57; module VIN, onboard regulator"),
        ("U3", "1", "IMU module (optional)", "on the main bus; address must not clash"),
        ("R1-R4", "a/r", "Pull-up resistors 4.7 k", "one pair per enabled segment (note 5)"),
        ("R5, R6", "2", "Pull-up resistors 10 k", "RESET of U1/U2 to +3V3 (note 3)"),
        ("-", "a/r", "Harness wire, sleeving, strain relief", "size from the measured current (note 7)"),
    ]
    y = table(10, 60, sum(BOM_W), "PARTS LIST", BOM_COLS, BOM, BOM_W)

    NET_COLS = ["FROM", "TO", "NET", "WIRE"]
    NET_W = [330, 420, 250, 120]
    NETS = [
        ("BT1 +", "F1 in", "+12V_RAW", "red"),
        ("F1 out", "SW1 1", "+12V_FUSED", "red"),
        ("SW1 2", "TB1 in", "+12V_SW", "red"),
        ("TB1 F2 out", "PS1 IN+", "+12V_PI", "red"),
        ("TB1 F3 out", "PS2 IN+", "+12V_ESP", "red"),
        ("BT1 -", "TB2", "GND", "black"),
        ("TB2", "PS1 IN- , PS2 IN-", "GND", "black"),
        ("PS1 OUT+ / OUT-", "A2 USB-C", "+5V_PI", "USB cable"),
        ("PS2 OUT", "A1 micro-USB", "+5V_ESP", "USB cable"),
        ("A1 3V3", "U1 VIN, U2 VIN", "+3V3", "pink"),
        ("A1 5V", "MOD01-16 VIN", "+5V_PAD", "orange"),
        ("A1 GND", "U1/U2 GND, MOD01-16 GND, U3 GND", "GND", "black"),
        ("A1 IO21", "U1 SDA, U2 SDA, U3 SDA", "SDA_MAIN", "blue"),
        ("A1 IO22", "U1 SCL, U2 SCL, U3 SCL", "SCL_MAIN", "yellow"),
        ("U1 SD0..SD7", "MOD01..MOD08 SDA", "SDA_A0..A7", "blue"),
        ("U1 SC0..SC7", "MOD01..MOD08 SCL", "SCL_A0..A7", "yellow"),
        ("U2 SD0..SD7", "MOD09..MOD16 SDA", "SDA_B0..B7", "blue"),
        ("U2 SC0..SC7", "MOD09..MOD16 SCL", "SCL_B0..B7", "yellow"),
        ("U1 A0, A1, A2", "GND", "ADDR_U1 = 0x70", "-"),
        ("U2 A0", "+3V3   (A1, A2 to GND)", "ADDR_U2 = 0x71", "-"),
        ("U1 RESET, U2 RESET", "+3V3 through 10 k", "RST_MUX", "-"),
    ]
    table(10, y + 74, sum(NET_W), "WIRE LIST", NET_COLS, NETS, NET_W, row_h=24)

    # verification column on the right
    VX, VW = 1200, 1050
    box(VX, 60, VW, 300, C["panel"], 0, C["ink"], 1.6)
    text(VX + 16, 92, "DEVICE DATA - AS VERIFIED AGAINST THE PRIMARY DATASHEETS", 13, C["ink"], "bold")
    ROWS = [
        "TCA9548A   TI SCPS207H, MAY 2012 - REVISED SEPTEMBER 2024",
        "           8 bidirectional channels; address byte 1110 A2 A1 A0 -> 0x70-0x77 (Figure 7-3, section 7.5.2)",
        "           VCC 1.65-5.5 V (recommended operating conditions); fSCL 0-400 kHz; 5 V tolerant I/O",
        "           RESET active low; connect to VCC through a pull-up when unused (pin functions table)",
        "",
        "MAX30102   Maxim 19-7740; Rev 1; 10/18",
        "           I2C write address 0xAE, read address 0xAF (7-bit 0x57); fSCL 0-400 kHz (electrical characteristics)",
        "           VDD 1.7-2.0 V (1.8 typ); VLED+ 3.1-5.0 V (3.3 typ) - the module's regulator makes 5 V VIN safe",
        "           FIFO depth 32 samples - read in bursts instead of switching channel per sample",
        "",
        "IMU U3     address unverified here: confirm against the datasheet of the module actually fitted,",
        "           and check it does not clash with 0x70 / 0x71",
    ]
    for i, r in enumerate(ROWS):
        text(VX + 16, 120 + i * 19, r, 10.5, C["ink"] if r[:1].isalpha() else C["muted"], font=MONO)

    box(VX, 394, VW, 250, C["panel"], 0, C["ink"], 1.6)
    text(VX + 16, 426, "BEFORE POWER-UP", 13, C["ink"], "bold")
    CHECK = [
        "1  Set PS1 to 5.1-5.2 V with no load, then connect A2.",
        "2  Check +5V_PAD and +3V3 at the far end of the harness, not only at the source.",
        "3  With power on and no I2C traffic, SDA and SCL must idle high near 3.3 V.",
        "4  Scan the bus: only 0x70 and 0x71 answer until a channel is enabled.",
        "5  Enable one channel at a time and confirm exactly one 0x57 answers.",
        "6  Check the SDA/SCL rise time on a scope with the full harness fitted.",
        "7  Shut A2 down cleanly before opening SW1.",
    ]
    for i, l in enumerate(CHECK):
        text(VX + 16, 456 + i * 24, l, 11.5, C["ink"], font=MONO)

    box(VX, 678, VW, 190, C["panel"], 0, C["ink"], 1.6)
    text(VX + 16, 710, "HOW THE FIRMWARE USES THE PADS", 13, C["ink"], "bold")
    FW = [
        "Scan     step through the segments, read each pad's IR level and test for skin contact",
        "Stream   keep the pad with the best signal selected; one pad streams at a time",
        "Standby  keep a second candidate sampling so a handover does not restart the estimator",
        "Hand over  when the streaming pad loses contact, switch to the standby and pick the next",
        "Rate     100 Hz per streaming pad, one 1 s packet per second over BLE (unchanged)",
    ]
    for i, l in enumerate(FW):
        text(VX + 16, 740 + i * 24, l, 11.5, C["ink"], font=MONO)
    add("</g>")
    return save("wheel_harness_16pads_sheet2.svg")

if __name__ == "__main__":
    p1, p2 = sheet1(), sheet2()
    print("wrote", p1, "and", p2)
    out = p1.with_suffix(".pdf")
    tmp = []
    for i, p in enumerate((p1, p2)):
        t = p.with_name(f".page{i}.pdf")
        subprocess.run(["rsvg-convert", "-f", "pdf", "-o", str(t), str(p)], check=True)
        tmp.append(t)
    subprocess.run(["pdfunite", *map(str, tmp), str(out)], check=True)
    for t in tmp:
        t.unlink()
    print("wrote", out)
