#!/usr/bin/env bash
# Launch the SkyOS Electron desktop on the active graphical login session.
#
# Adopt the session leader's display environment (Wayland/X11/DBus) so the
# window lands on the real desktop when started over SSH or a service
# manager. Caller-provided SKYOS_* variables pass straight through — e.g.
#   SKYOS_FABRIC_URL=http://192.168.12.210:8977 \
#   SKYOS_FABRIC_TOKEN="$(cat ~/skyos-fabric/token)" \
#   SKYOS_GEV_DIR=~/gods-eye-view ./skyos-desktop.sh
set -euo pipefail
cd "$(dirname "$0")"

session_pid=""
for proc in gnome-shell plasmashell sway labwc xfce4-session cinnamon budgie-desktop; do
  session_pid="$(pgrep -u "$USER" -x "$proc" 2>/dev/null | head -1 || true)"
  [ -n "$session_pid" ] && break
done

if [ -n "$session_pid" ] && [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  while IFS= read -r -d '' kv; do
    case "$kv" in
      DISPLAY=*|WAYLAND_DISPLAY=*|XDG_RUNTIME_DIR=*|DBUS_SESSION_BUS_ADDRESS=*|\
      XAUTHORITY=*|XDG_SESSION_TYPE=*|DESKTOP_SESSION=*)
        export "$kv" ;;
    esac
  done < "/proc/$session_pid/environ"
fi

exec ./node_modules/.bin/electron . "$@"
