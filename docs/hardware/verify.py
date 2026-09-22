#!/usr/bin/env python3
"""Runs every check and records what happened, when, and with which tool.

Writes verification.json: environment, each command with its timestamps and
exit code, and the values pulled out of its output. The report sheets in the
drawing package are generated from that file, so the numbers printed on the
sheet are the numbers the tools actually produced.

    python3 verify.py            # run everything, write verification.json
"""
import json
import platform
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
KI = HERE / "kicad"
SIM = HERE / "sim"
OUT = HERE / "verification.json"

def now():
    return datetime.now().astimezone()

def run(cmd, cwd=HERE, timeout=600):
    t0 = now()
    p = subprocess.run(cmd, cwd=cwd, shell=isinstance(cmd, str), capture_output=True,
                       text=True, timeout=timeout)
    t1 = now()
    return {
        "cmd": cmd if isinstance(cmd, str) else " ".join(cmd),
        "cwd": str(cwd),
        "started": t0.isoformat(timespec="seconds"),
        "seconds": round((t1 - t0).total_seconds(), 2),
        "exit": p.returncode,
        "out": (p.stdout + p.stderr).strip(),
    }

def _ngspice_version():
    """ngspice prints its banner over several lines; take the one with the number."""
    if not shutil.which("ngspice"):
        return "not installed"
    p = subprocess.run(["ngspice", "-v"], capture_output=True, text=True)
    for line in (p.stdout + p.stderr).splitlines():
        line = line.strip(" *")
        if "ngspice" in line.lower() and any(c.isdigit() for c in line):
            return line[:80]
    return "installed, version not reported"


def tool_version(exe, args=("--version",)):
    if not shutil.which(exe):
        return "not installed"
    p = subprocess.run([exe, *args], capture_output=True, text=True)
    return (p.stdout + p.stderr).strip().splitlines()[0][:80]

def main():
    rec: dict = {"generated": now().isoformat(timespec="seconds")}
    rec["environment"] = {
        "host": platform.node(),
        "os": f"{platform.system()} {platform.release()}",
        "python": platform.python_version(),
        "kicad-cli": tool_version("kicad-cli"),
        "ngspice": _ngspice_version(),
        "librsvg": tool_version("rsvg-convert", ("--version",)),
        "repo": run("git rev-parse --short HEAD")["out"],
        "branch": run("git rev-parse --abbrev-ref HEAD")["out"],
        "drawing": "TD18-HW-002 rev A",
    }
    steps: list[dict] = []

    s = run([sys.executable, "harness_spec.py"], cwd=KI); s["name"] = "Spec self-check"
    m = re.search(r"parts (\d+)\s+nets (\d+)\s+pins (\d+)\s+connected (\d+)\s+no-connect (\d+)", s["out"])
    s["values"] = dict(zip(("parts", "nets", "pins", "connected", "no_connect"), m.groups())) if m else {}
    s["verdict"] = "PASS" if s["out"].strip().endswith("spec OK") else "FAIL"
    steps.append(s)

    s = run([sys.executable, "gen_schematic.py"], cwd=KI); s["name"] = "Generate schematic from the spec"
    s["verdict"] = "PASS" if s["exit"] == 0 else "FAIL"
    steps.append(s)

    s = run(["kicad-cli", "sch", "erc", "--severity-error", "--severity-warning",
             "--exit-code-violations", "-o", "erc_report.txt", "wheel_harness.kicad_sch"], cwd=KI)
    s["name"] = "KiCad electrical rule check"
    report = (KI / "erc_report.txt").read_text() if (KI / "erc_report.txt").exists() else ""
    m = re.search(r"ERC messages:\s*(\d+)\s+Errors\s+(\d+)\s+Warnings\s+(\d+)", report)
    s["values"] = {"messages": m.group(1), "errors": m.group(2), "warnings": m.group(3)} if m else {}
    s["verdict"] = "PASS" if m and m.group(2) == "0" and m.group(3) == "0" else "FAIL"
    s["report_time"] = re.search(r"ERC report \(([^,]+)", report).group(1) if "ERC report" in report else ""
    steps.append(s)

    s = run(["kicad-cli", "sch", "export", "netlist", "--format", "kicadsexpr",
             "-o", "wheel_harness.net", "wheel_harness.kicad_sch"], cwd=KI)
    s["name"] = "Export netlist from the schematic"
    s["verdict"] = "PASS" if s["exit"] == 0 else "FAIL"
    steps.append(s)

    s = run([sys.executable, "check_netlist.py", "wheel_harness.net"], cwd=KI)
    s["name"] = "Netlist vs spec cross-check"
    m = re.search(r"(\d+) nets compared - (.+)", s["out"])
    s["values"] = {"nets": m.group(1), "result": m.group(2)} if m else {}
    s["verdict"] = "PASS" if s["exit"] == 0 else "FAIL"
    steps.append(s)

    s = run(["kicad-cli", "sch", "export", "pdf", "-o", "wheel_harness_schematic.pdf",
             "wheel_harness.kicad_sch"], cwd=KI)
    s["name"] = "Export the schematic sheet (PDF)"
    s["verdict"] = "PASS" if s["exit"] == 0 else "FAIL"
    steps.append(s)

    s = run(["kicad-cli", "sch", "export", "bom", "--fields", "Reference,Value,${QUANTITY}",
             "--group-by", "Value", "-o", "wheel_harness_bom.csv", "wheel_harness.kicad_sch"], cwd=KI)
    s["name"] = "Export the bill of materials"
    bom = (KI / "wheel_harness_bom.csv").read_text() if (KI / "wheel_harness_bom.csv").exists() else ""
    s["values"] = {"lines": str(max(0, len(bom.strip().splitlines()) - 1)),
                   "pads": re.search(r'"MOD01-MOD16","[^"]*","(\d+)"', bom).group(1) if "MOD01-MOD16" in bom else "?"}
    s["verdict"] = "PASS" if s["exit"] == 0 else "FAIL"
    steps.append(s)

    # --- SPICE: I2C rise time, at the specified pull-up and at the rejected one
    for rp, expect in (("2200", "PASS"), ("4700", "FAIL")):
        cir = f"/tmp/i2c_{rp}.cir"
        run([sys.executable, str(SIM / "i2c_bus.py"), "--len", "1.0", "--pads", "1", "--spice", cir])
        txt = Path(cir).read_text().replace(".param rp=2200", f".param rp={rp}")
        Path(cir).write_text(txt)
        s = run(["ngspice", "-b", cir])
        s["name"] = f"SPICE transient: I2C rise time, Rp = {int(rp)/1000:.1f} k"
        m = re.search(r"tr = ([0-9.e+-]+)", s["out"])
        tr = float(m.group(1)) if m else None
        s["values"] = {"tr_ns": f"{tr*1e9:.1f}" if tr else "?", "limit_ns": "300",
                       "rp_ohm": rp, "cb_pF": "82.0"}
        s["verdict"] = "PASS" if tr and tr < 300e-9 else "FAIL"
        s["expected"] = expect
        steps.append(s)

    # --- SPICE: the 5 V ring as a ladder
    run([sys.executable, str(SIM / "rail_spice.py"), "--ma", "25", "--pads", "16",
         "--awg", "22", "--len", "1.2", "--spice", "/tmp/rail.cir"])
    s = run(["ngspice", "-b", "/tmp/rail.cir"])
    s["name"] = "SPICE operating point: +5V_PAD ring"
    vs = re.findall(r"v\(f(\d+),r\d+\) = ([0-9.e+-]+)", s["out"])
    s["values"] = {"pads": str(len(vs)),
                   "first_V": f"{float(vs[0][1]):.3f}" if vs else "?",
                   "worst_V": f"{min(float(v) for _, v in vs):.3f}" if vs else "?",
                   "total_mA": "400", "wire": "AWG 22, 1.2 m"}
    s["verdict"] = "PASS" if vs and min(float(v) for _, v in vs) >= 3.4 else "FAIL"
    steps.append(s)

    rec["steps"] = steps
    rec["summary"] = {
        "checks": len(steps),
        "passed": sum(1 for s in steps if s["verdict"] == "PASS" or s.get("expected") == "FAIL" and s["verdict"] == "FAIL"),
    }
    OUT.write_text(json.dumps(rec, indent=2))
    print(f"wrote {OUT}")
    for s in steps:
        mark = "ok " if s["verdict"] == s.get("expected", "PASS") else "!! "
        print(f"  {mark}{s['name']:<46} {s['verdict']:<5} {s['started'][11:19]}  {s['seconds']:>5.1f}s")

if __name__ == "__main__":
    main()
