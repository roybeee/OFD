#!/bin/bash
task_root="$(cd -- "$(dirname -- "$0")" && pwd -P)"
/bin/bash "$task_root/infra/scripts/oda-local.sh" backup
task_code=$?
printf '\n창을 닫으려면 Enter 키를 누르세요. '
read -r _
exit "$task_code"
