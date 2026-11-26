#!/usr/bin/env bash
# Launch the SkyOS Electron desktop on the active graphical login session.
#
# Adopt the session's display environment so the window lands on the real
# desktop when started over SSH or a service manager. Preferred source is
# the systemd --user manager's imported environment; fallback scans
# candidate session processes for one carrying DISPLAY/WAYLAND_DISPLAY.
# Caller-provided SKYOS_* variables pass straight through — e.g.
#   SKYOS_FABRIC_URL=http://192.168.12.210:8977 \
#   SKYOS_FABRIC_TOKEN="$(cat ~/skyos-fabric/token)" \
#   SKYOS_GEV_DIR=~/gods-eye-view ./skyos-desktop.sh
set -euo pipefail
cd "$(dirname "$0")"

adopt_env() {
  local kv
  while IFS= read -r kv; do
    case "$kv" in
      DISPLAY=*|WAYLAND_DISPLAY=*|XDG_RUNTIME_DIR=*|DBUS_SESSION_BUS_ADDRESS=*|\
      XAUTHORITY=*|XDG_SESSION_TYPE=*|DESKTOP_SESSION=*)
        export "$kv" ;;
    esac
  done
}

if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    adopt_env < <(systemctl --user show-environment 2>/dev/null || true)
  fi
  if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    env_pid=""
    for proc in gnome-shell plasmashell sway labwc xfce4-session cinnamon \
        budgie-desktop gjs; do
      for pid in $(pgrep -u "$USER" -x "$proc" 2>/dev/null || true); do
        if tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null |
            grep -qE "^(DISPLAY|WAYLAND_DISPLAY)="; then
          env_pid="$pid"
          break 2
        fi
      done
    done
    [ -n "$env_pid" ] && adopt_env < <(tr '\0' '\n' < "/proc/$env_pid/environ")
  fi
fi

exec ./node_modules/.bin/electron . "$@"
