#!/usr/bin/env bash
# Builds and checks the whole harness design from the command line.
#   ./run_all.sh          generate, ERC, export, cross-check, simulate
# Needs: kicad (kicad-cli) and ngspice.
set -euo pipefail
cd "$(dirname "$0")"
SCH=wheel_harness.kicad_sch
step() { printf '\n== %s ==\n' "$1"; }

step "1. spec self-check"
python3 harness_spec.py

step "2. generate the schematic"
python3 gen_schematic.py

step "3. electrical rule check (KiCad)"
kicad-cli sch erc --severity-error --severity-warning --exit-code-violations \
  -o erc_report.txt "$SCH" || true
sed -n '1,60p' erc_report.txt

step "4. export schematic PDF and netlist"
kicad-cli sch export pdf -o wheel_harness_schematic.pdf "$SCH"
kicad-cli sch export netlist --format kicadsexpr -o wheel_harness.net "$SCH"
kicad-cli sch export bom --fields 'Reference,Value,${QUANTITY}' \
  --group-by Value -o wheel_harness_bom.csv "$SCH" || true

step "5. netlist vs spec cross-check"
python3 check_netlist.py wheel_harness.net

step "6. SPICE: I2C segment rise time"
python3 ../sim/i2c_bus.py --len 1.0 --pads 1 --spice /tmp/i2c_seg.cir >/dev/null
ngspice -b /tmp/i2c_seg.cir 2>&1 | grep -Ei "^tr =|VERDICT|error" | head -5

step "7. SPICE: 5 V ring drop"
python3 ../sim/rail_spice.py --ma 25 --pads 16 --awg 22 --len 1.2 --spice /tmp/rail.cir
ngspice -b /tmp/rail.cir 2>&1 | grep -Ei "^worst|error" | head -4

printf '\nAll steps finished. Outputs: erc_report.txt, wheel_harness_schematic.pdf, wheel_harness.net, wheel_harness_bom.csv\n'
