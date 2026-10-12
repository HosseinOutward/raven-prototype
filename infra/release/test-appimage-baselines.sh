#!/usr/bin/env bash
set -euo pipefail

artifact=${1:?artifact is required}
report=${2:?report is required}
artifact=$(readlink -f "$artifact")
report=$(readlink -m "$report")

test -f "$artifact"

# A bare container has no desktop libraries (X11, GL, fonts), which every desktop provides
# and an AppImage leaves out on purpose. What can really break an older distro is the C
# and C++ runtime the binary was linked against, so that is what is checked.
mkdir -p "$(dirname "$report")"
: > "$report"

images=(
  "ubuntu:22.04@sha256:0e0a0fc6d18feda9db1590da249ac93e8d5abfea8f4c3c0c849ce512b5ef8982"
  "ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90"
  "debian:12-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df"
)

for image in "${images[@]}"; do
  docker run --rm \
    --volume "$artifact:/artifact.AppImage:ro" \
    --env APPIMAGE_EXTRACT_AND_RUN=1 \
    "$image" \
    sh -eu -c 'mkdir /tmp/check && cd /tmp/check && test -x /artifact.AppImage && /artifact.AppImage --appimage-extract >/dev/null && test -x squashfs-root/AppRun && binary=$(find squashfs-root/usr/bin -maxdepth 1 -type f -perm -111 | head -n 1) && test -n "$binary" && if ldd "$binary" 2>&1 | grep -E "version .(GLIBC|GLIBCXX|CXXABI)[^ ]* not found"; then exit 1; fi'
  printf '%s extraction_and_glibc=passed\n' "$image" >> "$report"
done
