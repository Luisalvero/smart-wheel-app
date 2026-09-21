#!/usr/bin/env bash
# Compiles and uploads the PPG transmitter.  ./flash_esp32.sh [/dev/ttyUSB0]
# Board: classic ESP32 (esp32:esp32:esp32), ESP32 Arduino core 3.3.x,
# SparkFun MAX3010x library 1.1.2.
set -euo pipefail
cd "$(dirname "$0")/ppg_transmitter"
CLI="$(command -v arduino-cli || echo "$HOME/.local/bin/arduino-cli")"
# 40 MHz DIO flash, not the 80 MHz QIO default: at 80 MHz this board's
# bootloader intermittently misread its (verified-intact) flash -- "Checksum
# failed" -> "No bootable app partitions" -> reboot, 43 boots in 15 s, so BLE
# never started. At 40 MHz DIO: 0 checksum failures, stable streaming.
FQBN="esp32:esp32:esp32:FlashFreq=40,FlashMode=dio"
PORT="${1:-$(ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null | head -1 || true)}"
[[ -n "$PORT" ]] || { echo "No ESP32 serial port found (plug it in?)" >&2; exit 1; }
[[ -r "$PORT" && -w "$PORT" ]] || {
  echo "No permission on $PORT. Fix once with:" >&2
  echo "  sudo usermod -aG $(stat -c %G "$PORT") $USER   (then log out/in)" >&2
  exit 1; }
"$CLI" compile --fqbn "$FQBN" .
"$CLI" upload --fqbn "$FQBN" -p "$PORT" .
echo
echo "Flashed $PORT. Watch it with:"
echo "  $CLI monitor -p $PORT -c baudrate=115200"
