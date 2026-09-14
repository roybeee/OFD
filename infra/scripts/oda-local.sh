#!/bin/bash
# macOS ships Bash 3.2. Keep this launcher compatible and require only Docker.
set -euo pipefail
umask 077

task_action="${1:-start}"
task_repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
task_url="http://127.0.0.1:4175"

fail() { printf '\nODA 실행 오류: %s\n' "$*" >&2; exit 1; }
case "$task_action" in start|stop|status|logs|backup) ;; *) fail "지원 명령: start, stop, status, logs, backup" ;; esac

if [ "$(uname -s)" = Darwin ]; then
  task_state="$HOME/Library/Application Support/ODA Workstation"
else
  task_state="${XDG_DATA_HOME:-$HOME/.local/share}/oda-workstation"
fi
task_env="$task_state/local.env"
task_compose="$task_repo/infra/docker-compose.oda-local.yml"

command -v docker >/dev/null 2>&1 || fail "Docker Desktop을 설치하고 실행한 뒤 다시 열어 주세요. https://www.docker.com/products/docker-desktop/"
# Docker gives DOCKER_CONTEXT priority over DOCKER_HOST. Inspect that exact
# effective context first, then pin every daemon command to the verified socket.
# Do not change the user's globally selected context.
if [ -n "${DOCKER_CONTEXT:-}" ]; then
  task_docker_endpoint="$(docker context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" || fail "Docker 연결 설정을 확인할 수 없습니다."
elif [ -n "${DOCKER_HOST:-}" ]; then
  task_docker_endpoint="$DOCKER_HOST"
else
  task_docker_endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" || fail "Docker 연결 설정을 확인할 수 없습니다."
fi
case "$task_docker_endpoint" in unix://*|npipe://*) ;; *) fail "이 실행기는 이 컴퓨터의 Docker만 지원합니다. Docker Desktop의 로컬 context를 선택해 주세요." ;; esac
docker_local() {
  env -u DOCKER_CONTEXT -u DOCKER_HOST docker --host "$task_docker_endpoint" "$@"
}
docker_local compose version >/dev/null 2>&1 || fail "Docker Compose v2가 필요합니다. Docker Desktop을 업데이트해 주세요."
docker_local info >/dev/null 2>&1 || fail "Docker Desktop이 아직 준비되지 않았습니다. Docker Desktop을 열고 Engine running 상태에서 다시 실행해 주세요."

if [ "$task_action" = start ] && [ ! -f "$task_env" ]; then
  # An old volume without its matching secrets must not silently get new keys.
  task_existing_volume="$(docker_local volume ls --filter label=com.docker.compose.project=oda-workstation-local --filter label=com.docker.compose.volume=oda_local_postgres -q)"
  [ -z "$task_existing_volume" ] || fail "기존 ODA 데이터가 있지만 연결 설정을 찾지 못했습니다. 백업한 local.env를 복원해 주세요. 데이터를 초기화하지 않았습니다."
  command -v openssl >/dev/null 2>&1 || fail "암호 생성용 OpenSSL이 필요합니다. macOS 기본 OpenSSL 또는 LibreSSL을 확인해 주세요."
  mkdir -p "$task_state"
  chmod 700 "$task_state"
  task_temp="$(mktemp "$task_state/.local.env.XXXXXX")"
  trap 'rm -f -- "${task_temp:-}"' EXIT
  {
    printf 'ODA_LOCAL_DATABASE_PASSWORD=%s\n' "$(openssl rand -hex 32)"
    printf 'ODA_LOCAL_SESSION_SECRET=%s\n' "$(openssl rand -hex 48)"
    printf 'ODA_LOCAL_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32 | tr -d '\r\n')"
    printf 'ODA_LOCAL_SETUP_TOKEN=%s\n' "$(openssl rand -hex 32)"
  } > "$task_temp"
  # Atomic no-clobber: simultaneous double clicks retain the first generated keys.
  if ! ln "$task_temp" "$task_env" 2>/dev/null; then
    [ -f "$task_env" ] || fail "개인 실행 설정을 저장하지 못했습니다."
  fi
  rm -f "$task_temp"
  trap - EXIT
fi
[ -f "$task_env" ] || fail "ODA 실행 설정이 없습니다. Start-ODA.command를 먼저 실행해 주세요."
[ ! -L "$task_env" ] || fail "실행 설정이 심볼릭 링크입니다. 일반 local.env 파일로 복원해 주세요."
chmod 600 "$task_env"

# Never source an env file as shell code. Validate the exact format we generate.
task_secret_count=0
while IFS= read -r task_line || [ -n "$task_line" ]; do
  case "$task_line" in
    ODA_LOCAL_DATABASE_PASSWORD=*|ODA_LOCAL_SESSION_SECRET=*|ODA_LOCAL_SETUP_TOKEN=*)
      task_value="${task_line#*=}"
      case "$task_value" in *[!a-f0-9]*|'') fail "실행 설정 형식이 올바르지 않습니다. 백업한 local.env를 복원해 주세요." ;; esac
      [ "${#task_value}" -ge 64 ] || fail "실행 설정 암호 길이가 부족합니다."
      ;;
    ODA_LOCAL_ENCRYPTION_KEY=*)
      task_value="${task_line#*=}"
      case "$task_value" in *[!A-Za-z0-9+/=]*|'') fail "암호화 키 형식이 올바르지 않습니다." ;; esac
      [ "${#task_value}" -eq 44 ] || fail "암호화 키 길이가 올바르지 않습니다."
      ;;
    *) fail "실행 설정에 지원하지 않는 항목이 있습니다. 백업한 local.env를 복원해 주세요." ;;
  esac
  task_secret_count=$((task_secret_count + 1))
done < "$task_env"
[ "$task_secret_count" -eq 4 ] || fail "실행 설정이 불완전합니다."

compose() {
  # Explicit env file + removed inherited interpolation vars prevents an OFD or
  # another terminal session's exported values from changing this installation.
  env -u DOCKER_CONTEXT -u DOCKER_HOST \
    -u ODA_LOCAL_DATABASE_PASSWORD -u ODA_LOCAL_SESSION_SECRET -u ODA_LOCAL_ENCRYPTION_KEY -u ODA_LOCAL_SETUP_TOKEN \
    docker --host "$task_docker_endpoint" compose --project-name oda-workstation-local --env-file "$task_env" -f "$task_compose" "$@"
}

case "$task_action" in
  start)
    printf 'ODA를 준비하고 있습니다. 첫 실행에는 이미지 다운로드와 빌드로 몇 분 이상 걸릴 수 있습니다.\n'
    compose up -d --build --wait --wait-timeout 240 || fail "시작하지 못했습니다. 위 오류를 확인해 주세요. 4175 포트 사용 여부와 Docker 디스크 여유 공간을 확인하고 다시 실행하세요. 기존 정산 데이터는 삭제하지 않았습니다."
    printf '\nODA 실행 완료: %s\n처음에는 화면에서 관리자와 매장을 등록하세요. 이후 같은 주소에서 로그인할 수 있습니다.\n' "$task_url"
    task_token="$(sed -n 's/^ODA_LOCAL_SETUP_TOKEN=//p' "$task_env")"
    if [ "$(uname -s)" = Darwin ]; then
      open "$task_url/#setup=$task_token" >/dev/null 2>&1 || fail "브라우저를 열지 못했습니다. Start-ODA.command를 다시 열어 주세요."
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$task_url/#setup=$task_token" >/dev/null 2>&1 || true
    else
      printf '브라우저를 자동으로 열 수 없습니다. GUI가 있는 컴퓨터에서 실행해 주세요. 초기 설정 키는 local.env의 ODA_LOCAL_SETUP_TOKEN입니다.\n'
    fi
    ;;
  stop)
    compose stop
    printf '\nODA를 종료했습니다. 계정·정산·증빙은 그대로 보관됩니다.\n'
    ;;
  status) compose ps ;;
  logs) compose logs --tail=100 ;;
  backup)
    task_backup="$task_state/backups/$(date '+%Y%m%d-%H%M%S')"
    mkdir -p "$task_backup"
    if ! compose exec -T postgres pg_dump -U oda_local -d oda_local --format=custom > "$task_backup/oda.dump.partial"; then
      rm -f "$task_backup/oda.dump.partial"
      fail "백업하지 못했습니다. 먼저 ODA를 실행한 뒤 다시 백업해 주세요."
    fi
    mv "$task_backup/oda.dump.partial" "$task_backup/oda.dump"
    cp "$task_env" "$task_backup/local.env"
    chmod 600 "$task_backup/oda.dump" "$task_backup/local.env"
    printf '\n백업 완료: %s\n계정·정산·증빙과 연결 암호를 포함합니다. 이 폴더를 안전한 외장 저장소에도 복사해 주세요.\n' "$task_backup"
    ;;
esac
