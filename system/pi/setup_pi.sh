#!/usr/bin/env bash
# One-shot Raspberry Pi setup for the PPG relay.
#
#   cd /media/<you>/<usb>/PPG_System/pi      # or wherever you copied it
#   sudo ./setup_pi.sh
#
# Safe to rerun: rerunning after copying new code over is how you update.
# Options:
#   --no-service   install but do not start at boot (run it by hand instead)
#   --no-dashboard do not open the terminal dashboard at boot
#   --uninstall    stop and remove the service (keeps logs)
#
# What it does:
#   1. installs BlueZ + Python venv support (skipped if already present)
#   2. unblocks, enables and powers on Bluetooth
#   3. copies the relay to ~/PPG_Logger and builds a venv with bleak
#      (offline: put wheels in ./wheels and they are used instead of PyPI)
#   4. installs a systemd service that starts the relay at boot and restarts
#      it if it ever exits -- no terminal or manual steps needed after this
#   5. opens the terminal dashboard (ppg-monitor) automatically at login:
#      in a terminal window on the desktop, or full-screen on the console

set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
SERVICE=ppg-relay
MODE=install
DASHBOARD=1
for a in "$@"; do
  case "$a" in
    --no-service) MODE=noservice ;;
    --no-dashboard) DASHBOARD=0 ;;
    --uninstall)  MODE=uninstall ;;
    -h|--help)    sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run with sudo:  sudo $0 $*"
RUN_USER="${SUDO_USER:-}"
[[ -n "$RUN_USER" && "$RUN_USER" != root ]] || die "run via sudo from your normal user, not as root"
HOME_DIR="$(getent passwd "$RUN_USER" | cut -d: -f6)"
DEST="$HOME_DIR/PPG_Logger"
as_user() { sudo -u "$RUN_USER" -H "$@"; }

if [[ $MODE == uninstall ]]; then
  step "Removing $SERVICE service"
  systemctl disable --now "$SERVICE" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE.service"
  systemctl daemon-reload
  ok "service removed; code and logs left in $DEST"
  exit 0
fi

for f in ppg_relay.py ppg_protocol.py bluez_links.py ppg_monitor.py ppg-monitor; do
  [[ -f "$SRC/$f" ]] || die "$f not found next to this script ($SRC)"
done

# ---------------------------------------------------------------- 1. pkgs --
step "Checking system packages"
need=()
command -v bluetoothctl >/dev/null || need+=(bluez)
python3 -c "import venv, ensurepip" 2>/dev/null || need+=(python3-venv)
if ((${#need[@]})); then
  apt-get update -qq || warn "apt update failed (offline?) - trying install anyway"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}"
  ok "installed ${need[*]}"
else
  ok "bluez and python3-venv already present"
fi

PYV=$(python3 -c 'import sys;print(f"{sys.version_info[0]}.{sys.version_info[1]}")')
# bleak 1.x+ needs Python >= 3.10. Pi OS Bullseye ships 3.9, so pin the last
# bleak release that supports it rather than failing.
if python3 -c 'import sys;sys.exit(sys.version_info < (3,10))'; then
  BLEAK="bleak>=1.0"
else
  BLEAK="bleak==0.22.3"
  warn "Python $PYV is old; using $BLEAK (upgrade to Pi OS Bookworm for current bleak)"
fi
ok "Python $PYV"

# ----------------------------------------------------------- 2. bluetooth --
step "Bringing up Bluetooth"
command -v rfkill >/dev/null && rfkill unblock bluetooth || true
systemctl enable --now bluetooth >/dev/null
for _ in 1 2 3 4 5; do
  bluetoothctl show 2>/dev/null | grep -q "Powered: yes" && break
  bluetoothctl power on >/dev/null 2>&1 || true
  sleep 1
done
bluetoothctl show 2>/dev/null | grep -q "Powered: yes" || die "adapter will not power on (bluetoothctl show)"
ok "adapter powered: $(bluetoothctl show | awk '/Controller/{print $2; exit}')"
getent group bluetooth >/dev/null && usermod -aG bluetooth "$RUN_USER" && ok "$RUN_USER in bluetooth group"

# Initial LE connection parameters. The Pi is the central to the ESP32, so it
# sets the link's parameters at connect time. Unset, the kernel default
# supervision timeout is 420 ms: any radio gap longer than that in the first
# seconds of a connection drops it, which we measured as repeated drops ~2-3 s
# after connecting (BlueZ reason: Connection timeout). The ESP32 asks for a 4 s
# timeout once connected; setting it here makes the link robust from the first
# packet. Units per the Bluetooth Core Spec: interval 1.25 ms, timeout 10 ms.
set_le_param() {  # key value -- idempotent edit of the [LE] section
  local f=/etc/bluetooth/main.conf key=$1 val=$2
  grep -q '^\[LE\]' "$f" || printf '\n[LE]\n' >> "$f"
  if grep -qE "^${key}=" "$f"; then
    grep -qE "^${key}=${val}$" "$f" && return 1
    sed -i "s/^${key}=.*/${key}=${val}/" "$f"
  else
    sed -i "/^\[LE\]/a ${key}=${val}" "$f"
  fi
  return 0
}
if [[ -f /etc/bluetooth/main.conf ]]; then
  changed=0
  set_le_param MinConnectionInterval 24          && changed=1  # 30 ms
  set_le_param MaxConnectionInterval 40          && changed=1  # 50 ms
  set_le_param ConnectionLatency 0               && changed=1
  set_le_param ConnectionSupervisionTimeout 400  && changed=1  # 4 s
  if ((changed)); then
    systemctl restart bluetooth
    sleep 2
    bluetoothctl power on >/dev/null 2>&1 || true
    ok "LE link parameters set (4 s supervision timeout); bluetooth restarted"
  else
    ok "LE link parameters already set"
  fi
else
  warn "/etc/bluetooth/main.conf not found; using kernel default link parameters"
fi

# ---------------------------------------------------------------- 3. code --
step "Installing relay to $DEST"
as_user mkdir -p "$DEST/logs"
chmod 700 "$DEST/logs"   # health data: owner-only
install -o "$RUN_USER" -g "$RUN_USER" -m 0755 "$SRC/ppg_relay.py" "$DEST/"
install -o "$RUN_USER" -g "$RUN_USER" -m 0644 "$SRC/ppg_protocol.py" "$SRC/bluez_links.py" "$SRC/ppg_monitor.py" "$DEST/"
install -o "$RUN_USER" -g "$RUN_USER" -m 0755 "$SRC/ppg-monitor" "$DEST/"
ln -sf "$DEST/ppg-monitor" /usr/local/bin/ppg-monitor   # run 'ppg-monitor' from any terminal
ok "code copied"

if [[ ! -x "$DEST/venv/bin/python" ]]; then
  as_user python3 -m venv "$DEST/venv"
  ok "venv created"
fi
# Bundled wheels cover 64-bit Pi OS on Python 3.11 (Bookworm) and 3.13
# (Trixie), so the usual case needs no internet and installs in seconds.
# Anything else (32-bit OS, other Python) falls through to PyPI.
if ls "$SRC"/wheels/*.whl >/dev/null 2>&1 &&
   as_user "$DEST/venv/bin/pip" install -q --no-index --find-links "$SRC/wheels" "$BLEAK" rich 2>/dev/null; then
  ok "bleak installed from bundled wheels (no internet needed)"
else
  [[ -d "$SRC/wheels" ]] && warn "bundled wheels don't match this Pi ($(uname -m), Python $PYV); using PyPI"
  as_user "$DEST/venv/bin/pip" install -q --upgrade pip >/dev/null 2>&1 || true
  as_user "$DEST/venv/bin/pip" install -q "$BLEAK" rich \
    || die "pip install failed - connect the Pi to the internet"
  ok "bleak installed from PyPI"
fi
# Run from $DEST so ppg_protocol resolves to the installed copy, not the USB one.
(cd "$DEST" && as_user venv/bin/python -c "import bleak, dbus_fast, rich, ppg_protocol, bluez_links") \
  || die "import check failed"
ok "imports verified: $(as_user "$DEST/venv/bin/python" -c 'import importlib.metadata as m;print("bleak",m.version("bleak"),"dbus-fast",m.version("dbus-fast"))')"

# ------------------------------------------------------------- 4. service --
if [[ $MODE == noservice ]]; then
  step "Skipping service (--no-service). Run by hand with:"
  echo "    cd $DEST && venv/bin/python ppg_relay.py"
  exit 0
fi

step "Installing systemd service '$SERVICE'"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=ESP32 PPG -> Raspberry Pi -> laptop BLE relay
After=bluetooth.service
Requires=bluetooth.service

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$DEST
ExecStart=$DEST/venv/bin/python -u $DEST/ppg_relay.py --log-dir $DEST/logs
Restart=always
RestartSec=3
# Health data: every file the relay creates is owner-only.
UMask=0077
# Live dashboard state lives in RAM (/run/ppg-relay, tmpfs), not on the SD card.
RuntimeDirectory=ppg-relay
RuntimeDirectoryMode=0700
# Flush logs straight to the journal so 'journalctl -f' is live.
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"
ok "enabled at boot and started"

if ((DASHBOARD)); then
  step "Opening the dashboard automatically at login"
  if [[ "$(systemctl get-default)" == graphical.target ]]; then
    # XDG autostart: honoured by the Raspberry Pi OS desktop session.
    as_user mkdir -p "$HOME_DIR/.config/autostart" "$HOME_DIR/.local/share/applications"
    for f in "$HOME_DIR/.config/autostart/ppg-monitor.desktop" \
             "$HOME_DIR/.local/share/applications/ppg-monitor.desktop"; do
      cat > "$f" <<EOF
[Desktop Entry]
Type=Application
Name=PPG Monitor
Comment=Live ESP32 / phone link status, vitals and packets
Exec=$DEST/ppg-monitor
Icon=utilities-terminal
Terminal=false
Categories=Utility;
X-GNOME-Autostart-enabled=true
EOF
      chown "$RUN_USER:$RUN_USER" "$f"
    done
    ok "desktop: opens in a terminal window at login (also in the app menu)"
  else
    # Console-only Pi: log in automatically on the first console and start the
    # dashboard there. Ctrl+C drops to a normal shell.
    if command -v raspi-config >/dev/null; then
      raspi-config nonint do_boot_behaviour B2 && ok "console auto-login enabled"
    else
      warn "raspi-config not found; enable console auto-login yourself"
    fi
    PROFILE="$HOME_DIR/.bash_profile"
    [[ -f "$PROFILE" ]] || { printf '[ -f ~/.bashrc ] && . ~/.bashrc\n' > "$PROFILE"; chown "$RUN_USER:$RUN_USER" "$PROFILE"; }
    if ! grep -q "ppg-monitor" "$PROFILE"; then
      cat >> "$PROFILE" <<EOF

# PPG dashboard on the first console (added by setup_pi.sh). Ctrl+C for a shell.
if [ "\$(tty)" = /dev/tty1 ] && [ -z "\$DISPLAY\$WAYLAND_DISPLAY" ]; then
  $DEST/ppg-monitor
fi
EOF
    fi
    ok "console: dashboard starts on tty1 at boot"
  fi
fi

step "Checking it came up"
sleep 6
if systemctl is-active --quiet "$SERVICE"; then
  ok "$SERVICE is running"
else
  warn "$SERVICE is not active - recent log:"
fi
journalctl -u "$SERVICE" -n 12 --no-pager -o cat | sed 's/^/    /'

cat <<EOF

Done. The relay now starts on every boot. Useful commands:
  ppg-monitor                        live dashboard (any terminal)
  journalctl -u $SERVICE -f          live log
  systemctl status $SERVICE          is it running?
  sudo systemctl restart $SERVICE    restart after changes
  tail -f $DEST/logs/ppg_data.csv    watch vitals being logged
  sudo $0 --uninstall                remove the service
EOF
