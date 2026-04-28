#!/bin/bash
# Batch-generate multiple images. Tabs are reused between calls.
# Make sure `chatgpt-image-setup` is running in another terminal first.

set -e

mkdir -p output

PROMPTS=(
  "Generate an image: a serene mountain lake at sunrise, photo-realistic"
  "Generate an image: a cyberpunk street market at night, neon lights, rain"
  "Generate an image: a minimalist illustration of a fox, pastel colors"
  "画一张图：一只熊猫在竹林里吃竹子，水墨风格"
  "Generate an image: a 16:9 abstract dark tech wallpaper, glowing nodes"
)

i=1
for p in "${PROMPTS[@]}"; do
  echo "=== [$i/${#PROMPTS[@]}] $p ==="
  chatgpt-image -p "$p" -o "output/img_$i.jpg"
  i=$((i + 1))
  sleep 5  # gentle pacing to avoid rate limits
done

echo "=== All done. Output in output/ ==="
ls -la output/
