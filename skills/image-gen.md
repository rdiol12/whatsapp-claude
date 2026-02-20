# Image Generation + Editing

Generate and iteratively edit images via DALL-E.

## Setup
```
cd skills/image-gen && npm install
```
Requires: `OPENAI_API_KEY`

## Generate
```
node scripts/generate.js "a cyberpunk cat in neon rain" --variants 2 --style vivid --quality hd
```
Options: `--variants 1-3`, `--size 1024x1024|1024x1792|1792x1024`, `--style vivid|natural`, `--quality standard|hd`

## Edit
```
node scripts/edit.js --image output/gen_123.png "make the background darker" --mask mask.png
```

Output saved to `data/output/`. Use iteratively — generate, review, request changes.
