#!/usr/bin/env python3
"""Single source of truth for TD18-HW-002: parts, pins and nets.

The KiCad schematic, the ERC run and the cross-check against the drawing all
read this file, so the drawing and the schematic cannot drift apart.

Pin electrical types use KiCad's names:
    power_in   a supply pin that consumes
    power_out  a supply pin that sources (battery, converter output, regulator)
    bidirectional  I2C
    input / output / passive / unspecified
"""

# ---------------------------------------------------------------- parts ----
# ref: (symbol name, value, description, [(pin number, pin name, type, side)])
# side: "L" or "R" - which side of the symbol body the pin sits on.
def _mux_pins():
    pins = [("1", "VIN", "power_in", "L"), ("2", "GND", "power_in", "L"),
            ("3", "SDA", "bidirectional", "L"), ("4", "SCL", "bidirectional", "L"),
            ("5", "RESET", "input", "L"),
            ("6", "A0", "input", "L"), ("7", "A1", "input", "L"), ("8", "A2", "input", "L")]
    n = 9
    for ch in range(8):
        pins.append((str(n), f"SD{ch}", "bidirectional", "R")); n += 1
        pins.append((str(n), f"SC{ch}", "bidirectional", "R")); n += 1
    return pins

PARTS: dict[str, tuple[str, str, str, list]] = {
    "BT1": ("BATTERY", "12V LiFePO4 200Ah", "battery with internal BMS",
            [("1", "+", "power_out", "R"), ("2", "-", "power_out", "R")]),
    "F1": ("FUSE", "10A", "main fuse, within 15 cm of BT1 +",
           [("1", "A", "passive", "L"), ("2", "B", "passive", "R")]),
    "SW1": ("SWITCH", "battery master", "system disconnect",
            [("1", "A", "passive", "L"), ("2", "B", "passive", "R")]),
    "F2": ("FUSE", "5A", "TB1 way 1 -> PS1",
           [("1", "A", "passive", "L"), ("2", "B", "passive", "R")]),
    "F3": ("FUSE", "2A", "TB1 way 2 -> PS2",
           [("1", "A", "passive", "L"), ("2", "B", "passive", "R")]),
    "TB2": ("BUSBAR", "negative bus", "single return point",
            [("1", "1", "passive", "L"), ("2", "2", "passive", "L"),
             ("3", "3", "passive", "R"), ("4", "4", "passive", "R")]),
    "PS1": ("BUCK", "12V->5.1V 5A", "buck converter for the Pi",
            [("1", "IN+", "power_in", "L"), ("2", "IN-", "power_in", "L"),
             ("3", "OUT+", "power_out", "R"), ("4", "OUT-", "power_out", "R")]),
    "PS2": ("BUCK", "12V->5V USB", "buck converter for the ESP32",
            [("1", "IN+", "power_in", "L"), ("2", "IN-", "power_in", "L"),
             ("3", "OUT+", "power_out", "R"), ("4", "OUT-", "power_out", "R")]),
    "A1": ("ESP32_DEVKITC", "ESP32-WROOM-32", "sensor controller, BLE to A2",
           [("1", "VBUS_USB", "power_in", "L"), ("2", "GND", "power_in", "L"),
            ("3", "3V3", "power_out", "R"), ("4", "IO21_SDA", "bidirectional", "R"),
            ("5", "IO22_SCL", "bidirectional", "R"), ("6", "5V", "power_out", "R")]),
    "A2": ("RPI5", "Raspberry Pi 5", "relay, BLE both sides, Wi-Fi off",
           [("1", "VBUS", "power_in", "L"), ("2", "GND", "power_in", "L")]),
    "U1": ("TCA9548A", "TCA9548A 0x70", "I2C switch, pads 01-08", _mux_pins()),
    "U2": ("TCA9548A", "TCA9548A 0x71", "I2C switch, pads 09-16", _mux_pins()),
    "U3": ("IMU", "IMU module", "optional, on the main bus",
           [("1", "VIN", "power_in", "L"), ("2", "GND", "power_in", "L"),
            ("3", "SDA", "bidirectional", "R"), ("4", "SCL", "bidirectional", "R")]),
}
for n in range(1, 17):
    PARTS[f"MOD{n:02d}"] = ("MAX30102", "MAX30102 0x57", f"PPG pad {n}",
                            [("1", "VIN", "power_in", "L"), ("2", "GND", "power_in", "L"),
                             ("3", "SDA", "bidirectional", "R"), ("4", "SCL", "bidirectional", "R"),
                             ("5", "INT", "output", "R")])
# Pull-ups. R1/R2 hold up the main bus; one pair per multiplexer branch in use.
# 2.2 k, not 4.7 k: see sim/i2c_bus.py (tr 327 ns > 300 ns at 4.7 k on ~1 m).
for ref, val, desc in (("R1", "2k2", "SDA_MAIN pull-up"), ("R2", "2k2", "SCL_MAIN pull-up"),
                       ("R3", "2k2", "SDA_A0 pull-up (per enabled branch)"),
                       ("R4", "2k2", "SCL_A0 pull-up (per enabled branch)"),
                       ("R5", "10k", "U1 RESET pull-up"), ("R6", "10k", "U2 RESET pull-up")):
    PARTS[ref] = ("R", val, desc, [("1", "1", "passive", "L"), ("2", "2", "passive", "R")])
# Power flags: tell ERC that these nets are really driven (KiCad convention).
for ref, net in (("PWR1", "GND"), ("PWR2", "+5V_PAD"), ("PWR3", "+3V3")):
    PARTS[ref] = ("PWR_FLAG", "PWR_FLAG", f"ERC flag on {net}",
                  [("1", "pwr", "power_out", "R")])

# ----------------------------------------------------------------- nets ----
NETS: dict[str, list[tuple[str, str]]] = {
    "+12V_RAW":   [("BT1", "1"), ("F1", "1")],
    "+12V_FUSED": [("F1", "2"), ("SW1", "1")],
    "+12V_SW":    [("SW1", "2"), ("F2", "1"), ("F3", "1")],
    "+12V_PI":    [("F2", "2"), ("PS1", "1")],
    "+12V_ESP":   [("F3", "2"), ("PS2", "1")],
    "+5V_PI":     [("PS1", "3"), ("A2", "1")],
    "+5V_ESP":    [("PS2", "3"), ("A1", "1")],
    "+3V3":       [("A1", "3"), ("U1", "1"), ("U2", "1"), ("U3", "1"),
                   ("R1", "1"), ("R2", "1"), ("R3", "1"), ("R4", "1"),
                   ("R5", "1"), ("R6", "1"), ("PWR3", "1")],
    "SDA_MAIN":   [("A1", "4"), ("U1", "3"), ("U2", "3"), ("U3", "3"), ("R1", "2")],
    "SCL_MAIN":   [("A1", "5"), ("U1", "4"), ("U2", "4"), ("U3", "4"), ("R2", "2")],
    "RST_MUX":    [("U1", "5"), ("U2", "5"), ("R5", "2"), ("R6", "2")],
}
# Ground: battery negative, the bus bar, every converter return and every board.
gnd = [("BT1", "2"), ("TB2", "1"), ("TB2", "2"), ("TB2", "3"), ("TB2", "4"),
       ("PS1", "2"), ("PS1", "4"), ("PS2", "2"), ("PS2", "4"),
       ("A1", "2"), ("A2", "2"), ("U1", "2"), ("U2", "2"), ("U3", "2"),
       ("PWR1", "1")]
# Address straps: U1 = 0x70 (A0-A2 low), U2 = 0x71 (A0 high, A1-A2 low)
gnd += [("U1", "6"), ("U1", "7"), ("U1", "8"), ("U2", "7"), ("U2", "8")]
NETS["+3V3"].append(("U2", "6"))
# +5V_PAD: the ring that feeds every pad, from A1's 5 V pin (the DevKitC passes
# USB 5 V to that pin; note 7 sizes PS2 for the total pad current)
pad5 = [("A1", "6"), ("PWR2", "1")]
for n in range(1, 17):
    ref = f"MOD{n:02d}"
    pad5.append((ref, "1"))
    gnd.append((ref, "2"))
NETS["+5V_PAD"] = pad5
NETS["GND"] = gnd
# One segment net per multiplexer channel: SDn/SCn -> the pad on that channel.
for i in range(8):
    NETS[f"SDA_A{i}"] = [("U1", str(9 + i * 2)), (f"MOD{i+1:02d}", "3")]
    NETS[f"SCL_A{i}"] = [("U1", str(10 + i * 2)), (f"MOD{i+1:02d}", "4")]
    NETS[f"SDA_B{i}"] = [("U2", str(9 + i * 2)), (f"MOD{i+9:02d}", "3")]
    NETS[f"SCL_B{i}"] = [("U2", str(10 + i * 2)), (f"MOD{i+9:02d}", "4")]
# The example branch that carries the pull-ups drawn on the sheet
NETS["SDA_A0"].append(("R3", "2"))
NETS["SCL_A0"].append(("R4", "2"))
# Pad interrupt pins are unused in this revision.
NO_CONNECT = [(f"MOD{n:02d}", "5") for n in range(1, 17)]

def pin_index() -> dict[tuple[str, str], str]:
    """(ref, pin number) -> net name. Raises if a pin is on two nets."""
    idx: dict[tuple[str, str], str] = {}
    for net, pins in NETS.items():
        for p in pins:
            if p in idx:
                raise ValueError(f"{p} is on both {idx[p]} and {net}")
            idx[p] = net
    return idx

if __name__ == "__main__":
    idx = pin_index()
    all_pins = {(r, p[0]) for r, (_, _, _, pins) in PARTS.items() for p in pins}
    connected = set(idx) | set(NO_CONNECT)
    missing = sorted(all_pins - connected)
    extra = sorted(connected - all_pins)
    print(f"parts {len(PARTS)}  nets {len(NETS)}  pins {len(all_pins)}  "
          f"connected {len(idx)}  no-connect {len(NO_CONNECT)}")
    if missing:
        print("UNCONNECTED PINS:", missing)
    if extra:
        print("NETS REFER TO PINS THAT DO NOT EXIST:", extra)
    for net, pins in NETS.items():
        if len(pins) < 2:
            print(f"NET WITH ONE PIN: {net} {pins}")
    print("spec OK" if not (missing or extra) else "spec INCOMPLETE")
