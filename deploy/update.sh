#!/usr/bin/env bash
set -euo pipefail

source_image=${HUDDLE_RELEASE_IMAGE:-ghcr.io/imnallen/huddle:main}
backups=/var/backups/huddle
project=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

image_id() {
  docker image inspect --format '{{.Id}}' "$1"
}

# `docker compose ps -a` also lists `run` containers, so a killed migration would pass for a deployed server.
# A container that never started was left by a crash inside `compose up`, so it is not deployed either.
deployed_image() {
  docker ps -aq \
    --filter "label=com.docker.compose.project=$(basename "$project")" \
    --filter label=com.docker.compose.service=server \
    --filter label=com.docker.compose.oneoff=False |
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

restore_image() {
  docker tag "$1" huddle:current
  extract_deploy_files "$1"
  docker compose up -d --no-build server
}

# The server shares the sidecar's network, so a sidecar restart cuts it off until the server restarts too.
heal_server() {
  if [[ $(docker compose ps --format '{{.Health}}' server) == *unhealthy* ]]; then
    echo "The server is unhealthy. Restarting it."
    docker compose restart server
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
