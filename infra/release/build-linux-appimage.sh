#!/usr/bin/env bash
# Builds Raven's Linux AppImage inside the pinned Ubuntu 22.04 image, so it runs on that
# release and anything newer. Run on Linux with Docker (release.ps1 runs it in WSL).
#
#   build-linux-appimage.sh <source root> <version> <output directory>
#
# The source root is an exported checkout that already holds apps/desktop/dist (the
# frontend is built once, on the release machine). Cargo's registry and target
# directories are kept beside the output so later builds are incremental.
set -euo pipefail

root=$(readlink -f "${1:?source root is required}")
version=${2:?version is required}
out=$(readlink -m "${3:?output directory is required}")

case "$version" in
  *[!0-9A-Za-z.+-]*|'') echo "invalid version: $version" >&2; exit 2 ;;
esac

test -f "$root/apps/desktop/src-tauri/Cargo.lock"
test -f "$root/apps/desktop/dist/index.html"
test -f "$root/infra/release/Dockerfile.linux-appimage"

cache=${RAVEN_BUILD_CACHE:-$(dirname "$out")/cache}
mkdir -p "$out" "$cache/cargo" "$cache/target"
rm -f "$out"/*

dockerfile_hash=$(sha256sum "$root/infra/release/Dockerfile.linux-appimage" | cut -c1-16)
image="raven-linux-builder:$dockerfile_hash"
docker build --tag "$image" --file "$root/infra/release/Dockerfile.linux-appimage" "$root/infra/release"

docker run --rm \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp/raven-home \
  --env CARGO_HOME=/cargo-cache \
  --env XDG_CACHE_HOME=/cargo-cache/xdg \
  --env CARGO_TARGET_DIR=/cargo-target \
  --env APPIMAGE_EXTRACT_AND_RUN=1 \
  --volume "$root:/workspace" \
  --volume "$cache/cargo:/cargo-cache" \
  --volume "$cache/target:/cargo-target" \
  --workdir /workspace/apps/desktop \
  "$image" \
  cargo tauri build --bundles appimage --config /workspace/infra/release/tauri.linux.release.conf.json

mapfile -t artifacts < <(find "$cache/target/release/bundle/appimage" -maxdepth 1 -type f -name '*.AppImage' -newer "$root/apps/desktop/dist/index.html" -print)
if [ "${#artifacts[@]}" -ne 1 ]; then
  echo "expected exactly one freshly built AppImage, found ${#artifacts[@]}" >&2
  exit 1
fi
artifact="$out/Raven_${version}_amd64.AppImage"
cp "${artifacts[0]}" "$artifact"
chmod 0755 "$artifact"

"$root/infra/release/test-appimage-baselines.sh" "$artifact" "$out/compatibility-linux.txt"
echo "built $artifact"
