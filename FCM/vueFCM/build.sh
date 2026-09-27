#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dist_images="$script_dir/../static/FCM/FCMvuedist/images"

cd "$script_dir"
npm run build

# Source images already live under FCM/static/FCM/images. Vite copies them into
# the bundle as well, but the deployed app uses the canonical static paths.
if [ -d "$dist_images" ]; then
    rm -rf -- "$dist_images"
    echo "[cleanup] Removed duplicate generated FCM images."
fi
