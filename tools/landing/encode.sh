#!/usr/bin/env bash
# Encode the capture.mjs PNGs into the AVIF/WebP sizes about.html uses.
#   tools/landing/encode.sh /tmp/cr-shots src/landing/img
set -euo pipefail
src=${1:?png dir}
out=${2:?output dir}
mkdir -p "$out"
for png in "$src"/*.png; do
  name=$(basename "$png" .png)
  case "$name" in
    phone-*) widths="390 780" ;;
    *) widths="720 1440" ;;
  esac
  for w in $widths; do
    convert "$png" -strip -filter Lanczos -resize "${w}x" -quality 50 "$out/$name-$w.avif"
    convert "$png" -strip -filter Lanczos -resize "${w}x" -quality 78 "$out/$name-$w.webp"
    for f in "$out/$name-$w".{avif,webp}; do
      echo "$(identify -format '%wx%h' "$f") $(stat -c %s "$f") $f"
    done
  done
done
