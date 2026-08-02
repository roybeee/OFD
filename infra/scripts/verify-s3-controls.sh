#!/bin/sh
set -eu

: "${S3_BUCKET:?S3_BUCKET is required}"

versioning_status="$(aws s3api get-bucket-versioning --bucket "${S3_BUCKET}" --query Status --output text)"
if [ "${versioning_status}" != "Enabled" ]; then
  printf '%s\n' 'S3 bucket versioning is not enabled.' >&2
  exit 1
fi

aws s3api get-bucket-encryption --bucket "${S3_BUCKET}" >/dev/null
aws s3api get-public-access-block --bucket "${S3_BUCKET}" >/dev/null
printf '%s\n' 'S3 versioning, encryption and public-access-block controls are present.'
