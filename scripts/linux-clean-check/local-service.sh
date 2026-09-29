# NR-117: source after the artifact and its runtime libraries are installed.
# Run the actual shipped desktop: Xvfb supplies GTK's display requirement; no
# replacement resolver/harness can accidentally test newer code than the deb.
check_local_service() {
  local executable="$1" expected_node="$2" expected_server="$3"
  apt-get install -y -qq --no-install-recommends xvfb curl dbus-x11 > /tmp/service-tools.log 2>&1 \
    || { tail -20 /tmp/service-tools.log; fail "install local-service probe tools"; }
  local home=/tmp/nr117-home port=41987
  mkdir -p "$home"
  Xvfb :43 -screen 0 1280x800x24 > /tmp/service-xvfb.log 2>&1 &
  local display_pid=$!
  sleep 2
  env -u FLOWMIC_SERVER_URL DISPLAY=:43 WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 \
    FLOWMIC_HOME="$home" FLOWMIC_SIDECAR_PORT="$port" \
    XDG_DATA_HOME="$home/data" XDG_STATE_HOME="$home/state" XDG_CONFIG_HOME="$home/config" \
    dbus-run-session -- "$executable" > /tmp/service-desktop.log 2>&1 &
  local desktop_pid=$! status=000
  for _ in $(seq 1 40); do
    status="$(curl --silent --output /tmp/service-health.json --write-out '%{http_code}' \
      --max-time 1 "http://127.0.0.1:$port/api/health" || true)"
    [ "$status" = 200 ] && break
    sleep 1
  done
  if [ "$status" != 200 ]; then
    cat /tmp/service-desktop.log
    find "$home" /root/.local/share -name '*.log' -type f -exec tail -40 {} \; 2>/dev/null
    kill "$desktop_pid" "$display_pid" 2>/dev/null || true
    fail "local service HTTP $status (expected 200; host $(/usr/bin/node --version))"
  fi
  cat /tmp/service-health.json
  echo
  # Assert both actual script identity and the running process's executable.
  /usr/bin/node -e 'const h = require("/tmp/service-health.json"); if (h.script !== process.argv[1]) process.exit(1)' \
    "$expected_server" || fail "health came from a different server.js"
  local found=0 process_exe
  for process_exe in /proc/[0-9]*/exe; do
    [ "$(readlink "$process_exe" 2>/dev/null)" = "$expected_node" ] && found=1
  done
  [ "$found" = 1 ] || fail "HTTP 200 without the bundled Node process"
  echo "PASS local service: HTTP 200; node=$expected_node; server=$expected_server; old host=$(/usr/bin/node --version)"
  kill "$desktop_pid" "$display_pid" 2>/dev/null || true
}
