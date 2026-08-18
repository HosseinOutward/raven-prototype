#!/usr/bin/env bash
set -euo pipefail

root=${1:?source root is required}
version=${2:?version is required}
commit=${3:?commit is required}

case "$version" in
  *[!0-9A-Za-z.+-]*|'') exit 2 ;;
esac
case "$commit" in
  *[!0-9a-f]*|'') exit 2 ;;
esac

root=$(readlink -f "$root")
case "$root" in
  /home/soroush/services/raven/builds/*/source) ;;
  *) exit 2 ;;
esac

test -f "$root/apps/desktop/src-tauri/Cargo.lock"
test -f "$root/apps/desktop/dist/index.html"
test -f "$root/infra/release/Dockerfile.linux-appimage"

workspace=$(dirname "$root")
out="$workspace/out"
cache=/home/soroush/services/raven/build-cache/cargo
mkdir -p "$out" "$cache"
rm -f "$out"/*

dockerfile_hash=$(sha256sum "$root/infra/release/Dockerfile.linux-appimage" | cut -c1-16)
image="raven-linux-builder:$dockerfile_hash"
docker build --pull --tag "$image" --file "$root/infra/release/Dockerfile.linux-appimage" "$root/infra/release"

docker run --rm \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp/raven-home \
  --env CARGO_HOME=/cargo-cache \
  --env CARGO_TARGET_DIR=/workspace/target-linux \
  --env APPIMAGE_EXTRACT_AND_RUN=1 \
  --volume "$root:/workspace" \
  --volume "$cache:/cargo-cache" \
  --workdir /workspace/apps/desktop \
  "$image" \
  cargo tauri build --bundles appimage --config /workspace/infra/release/tauri.linux.release.conf.json

mapfile -t artifacts < <(find "$root/target-linux/release/bundle/appimage" -maxdepth 1 -type f -name '*.AppImage' -print)
test "${#artifacts[@]}" -eq 1
artifact="$out/raven_${version}_linux_x86_64.AppImage"
cp "${artifacts[0]}" "$artifact"
chmod 0755 "$artifact"

{
  docker image inspect "$image" --format 'builder_image_id={{.Id}}'
  printf 'base_image=ubuntu:22.04@sha256:0e0a0fc6d18feda9db1590da249ac93e8d5abfea8f4c3c0c849ce512b5ef8982\n'
  docker run --rm "$image" rustc --version
  docker run --rm "$image" cargo --version
  docker run --rm "$image" cargo-tauri --version
  printf 'git_commit=%s\n' "$commit"
} > "$out/toolchain-linux.txt"

"$root/infra/release/test-appimage-baselines.sh" "$artifact" "$out/compatibility-linux.txt"
sha256sum "$artifact" > "$out/raven_${version}_linux_x86_64.AppImage.sha256"
