#!/usr/bin/env bash
set -euo pipefail

main() {
  if [[ $# -ne 2 || $1 != --server-url || ! $2 =~ ^https://[^/[:space:]]+/?$ ]]; then
    echo "Usage: install.sh --server-url https://huddle.your-tailnet.ts.net" >&2
    exit 2
  fi
  local server_url=$2 project password
  project=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

  if [[ ! -e $project/.env ]]; then
    password=$(openssl rand -hex 24)
    (
      umask 077
      printf 'POSTGRES_PASSWORD=%s\nSERVER_URL=%s\n' "$password" "$server_url" >"$project/.env.partial"
    )
    mv "$project/.env.partial" "$project/.env"
  fi

  install -m 644 "$project"/deploy/systemd/huddle-update.{service,timer} /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now huddle-update.timer

  cat <<NEXT
The updater is installed. Next:

1. Turn on HTTPS certificates in your tailnet's DNS settings.
2. Start the sidecar: systemctl start huddle-update.service
3. In $project, run docker compose logs tailscale and open the newest login link. The link changes every minute.
4. Deploy now: systemctl start huddle-update.service
5. In $project, run docker compose logs server and copy the setup code.
6. Open $server_url from a device signed in to Tailscale as you.
NEXT
}

main "$@"
