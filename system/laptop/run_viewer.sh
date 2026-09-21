#!/usr/bin/env bash
# Launches the PPG viewer, creating its Python environment on first run.
#   ./run_viewer.sh            via the Raspberry Pi relay
#   ./run_viewer.sh --direct   straight to the ESP32 (no Pi)
#   ./run_viewer.sh --demo     synthetic data, no Bluetooth
set -euo pipefail
cd "$(dirname "$0")"
VENV="${PPG_VENV:-$HOME/ppg-venv}"
if [[ ! -x "$VENV/bin/python" ]] || ! "$VENV/bin/python" -c "import bleak, pyqtgraph, PySide6" 2>/dev/null; then
  echo "Setting up $VENV (first run only)..."
  # --system-site-packages reuses a distro PySide6 when present (it is large).
  python3 -m venv --system-site-packages "$VENV"
  "$VENV/bin/pip" install -q bleak pyqtgraph PySide6 numpy
fi
exec "$VENV/bin/python" ppg_viewer.py "$@"
