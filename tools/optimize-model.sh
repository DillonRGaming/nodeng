#!/usr/bin/env bash
# Shrinks a Sketchfab-style car .glb for real-time use: simplify meshes, compress textures to
# 1024px WebP, meshopt-compress geometry. Node names are kept so wheels can still be found.
# usage: tools/optimize-model.sh input.glb models/output.glb
set -euo pipefail
npx --yes @gltf-transform/cli@4 optimize "$1" "$2" \
  --compress meshopt --texture-compress webp --texture-size 1024 \
  --flatten false --join false --instance false \
  --simplify false  # body panels must not be simplified (breaks their shading); see notes below
# Note: the shipped models/seltos.glb was made by first simplifying only small/interior parts
# (selective pass keeping paint, glass, lights and wheels at full detail), then running this.
