#!/usr/bin/env bash
set -euo pipefail

source_image=${HUDDLE_RELEASE_IMAGE:-ghcr.io/imnallen/huddle:main}
backups=/var/backups/huddle
project=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

image_id() {
  docker image inspect --format '{{.Id}}' "$1"
}

# `docker compose ps -a` also lists `run` containers, so a killed migration would pass for a deployed server.
service_containers() {
  docker ps -aq \
    --filter "label=com.docker.compose.project=$(basename "$project")" \
    --filter "label=com.docker.compose.service=$1" \
    --filter label=com.docker.compose.oneoff=False
}

# A container that never started was left by a crash inside `compose up`, so it is not deployed.
deployed_image() {
  service_containers server |
    xargs -r docker inspect --format '{{if ne .State.Status "created"}}{{.Image}}{{end}}' |
    awk 'NF && !found++'
}

extract_deploy_files() {
  local staging="$project/.extract" file
  rm -rf "$staging"
  mkdir "$staging"
  docker run --rm "$1" tar -C /app -c compose.yaml deploy | tar -x --no-same-owner -C "$staging"
  # Renamed one file at a time: a partial compose.yaml or update.sh would stop every later run,
  # and the sidecar's bind mount needs deploy/tailscale to stay the same directory.
  while IFS= read -r file; do
    mkdir -p "$project/$(dirname "$file")"
    mv -f "$staging/$file" "$project/$file"
  done < <(cd "$staging" && find . -type f)
  rm -rf "$staging"
}

backup_database() {
  local partial="$backups/partial" dumps_oldest_first
  (
    umask 077
    mkdir -p "$backups"
    docker compose exec -T db pg_dump -U huddle -Fc huddle >"$partial"
  )
  mv "$partial" "$backups/$(date -u +%Y%m%dT%H%M%SZ).dump"
  dumps_oldest_first=("$backups"/*.dump)
  if ((${#dumps_oldest_first[@]} > 14)); then
    rm -f -- "${dumps_oldest_first[@]:0:${#dumps_oldest_first[@]}-14}"
  fi
}

try_start_livekit() {
  docker compose up -d --no-build livekit || echo "LiveKit did not start. Chat is unaffected." >&2
}

try_restart_livekit() {
  docker compose restart livekit || echo "LiveKit did not restart. Chat is unaffected." >&2
}

restore_image() {
  docker tag "$1" huddle:current
  extract_deploy_files "$1"
  docker compose up -d --no-build server
  try_start_livekit
}

# LiveKit binds its UDP port once, at start, and only if tailscale0 is already up. Started any earlier, as a reboot
# can do, it answers HTTP and carries no audio until it restarts.
livekit_missing_udp() {
  [[ -n $(docker compose ps -q --status running livekit 2>/dev/null) ]] && tailscale_running &&
    ! docker compose exec -T tailscale netstat -uln | grep -q ':7882 '
}

# The server and LiveKit share the sidecar's network, so a sidecar restart cuts them off until they restart too.
heal_server() {
  if [[ $(docker compose ps --format '{{.Health}}' server) == *unhealthy* ]]; then
    echo "The server is unhealthy. Restarting it and LiveKit."
    docker compose restart server
    try_restart_livekit
  elif livekit_missing_udp; then
    echo "LiveKit has no UDP port. Restarting it."
    try_restart_livekit
  fi
}

current_image_is_safe_to_start() {
  local deployed=$1 pending_rollback=$2
  [[ -n $deployed && -z $pending_rollback ]]
}

ensure_voice_secret() {
  if grep -q '^LIVEKIT_API_SECRET=' .env; then
    return
  fi
  local secret
  secret=$(openssl rand -hex 32)
  (
    umask 077
    if [[ -n $(tail -c 1 .env) ]]; then
      echo >>.env
    fi
    printf 'LIVEKIT_API_SECRET=%s\n' "$secret" >>.env
  )
}

carries_voice_secret() {
  service_containers "$1" | xargs -r docker inspect --format '{{.Config.Env}}' | grep -qF "$2"
}

recreate_services_missing_voice_secret() {
  local secret
  secret=$(sed -n 's/^LIVEKIT_API_SECRET=//p' .env | tail -n 1)
  if ! carries_voice_secret livekit "$secret" || ! carries_voice_secret server "$secret"; then
    docker compose up -d --no-build livekit server || echo "LiveKit did not start. Chat is unaffected." >&2
  fi
}

# Until someone logs in, the sidecar exits every minute and takes the server's network with it, so a healthy
# image would fail its deploy.
tailscale_running() {
  docker compose exec -T tailscale tailscale status --self --peers=false --json 2>/dev/null |
    grep -q '"BackendState": "Running"'
}

main() {
  cd "$project"

  local next deployed failed pending_rollback rollback
  docker pull -q "$source_image" >/dev/null
  next=$(image_id "$source_image")
  deployed=$(deployed_image)
  failed=$(image_id huddle:failed 2>/dev/null || true)
  pending_rollback=$(image_id huddle:rollback 2>/dev/null || true)

  ensure_voice_secret
  if current_image_is_safe_to_start "$deployed" "$pending_rollback"; then
    recreate_services_missing_voice_secret
  fi

  if [[ $next == "$failed" ]]; then
    echo "Skipping $next because its last deploy failed. To retry it, run docker rmi huddle:failed."
    if [[ -n $pending_rollback ]]; then
      echo "Finishing an interrupted restore of $pending_rollback."
      restore_image "$pending_rollback"
      docker rmi huddle:rollback >/dev/null
    else
      heal_server
    fi
    exit 0
  fi
  if [[ $next == "$deployed" && -z $pending_rollback ]]; then
    heal_server
    exit 0
  fi

  echo "Deploying $next."
  extract_deploy_files "$next"
  docker compose up -d --wait db tailscale
  if ! tailscale_running; then
    echo "Waiting for a Tailscale login. Open the newest link from docker compose logs tailscale."
    exit 0
  fi
  backup_database
  rollback=${pending_rollback:-$deployed}
  if [[ -n $rollback ]]; then
    docker tag "$rollback" huddle:rollback
  fi
  docker tag "$next" huddle:current

  if docker compose run --rm -T --no-deps server node --import tsx scripts/migrate.ts &&
    docker compose up -d --wait --wait-timeout 180 --no-build server; then
    try_start_livekit
    if [[ -n $failed ]]; then
      # A container left by a crash can hold this image, and a stale tag does no harm.
      docker rmi huddle:failed >/dev/null || true
    fi
    if [[ -n $rollback ]]; then
      docker rmi huddle:rollback >/dev/null
    fi
    docker image prune -f >/dev/null
    echo "Deployed $next, revision $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$next")."
    exit 0
  fi

  docker tag "$next" huddle:failed
  if [[ -z $rollback ]]; then
    echo "Deploy of $next failed, and there is no earlier image to restore. It is tagged huddle:failed." >&2
    exit 1
  fi
  restore_image "$rollback"
  docker rmi huddle:rollback >/dev/null
  echo "Deploy of $next failed, and it is tagged huddle:failed. Restored the previous image, $rollback." >&2
  echo "Migrations only go forward. If the restored image cannot use the database, restore the newest dump in $backups." >&2
  exit 1
}

main "$@"
