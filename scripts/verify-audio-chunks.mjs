#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";

async function main() {
  const root = process.cwd();
  const manifestText = (await fsp.readFile(path.join(root, "audio_chunks_manifest.json"), "utf8")).replace(/^\uFEFF/, "");
  const manifest = JSON.parse(manifestText);
  let count = 0;
  let totalBytes = 0;
  for (const video of manifest.videos || []) {
    for (const chunk of video.chunks || []) {
      const file = path.join(root, chunk.file);
      const data = await fsp.readFile(file);
      count += 1;
      totalBytes += data.length;
      const head = data.slice(0, 120).toString("utf8");
      if (head.startsWith("version https://git-lfs.github.com/spec/v1")) {
        throw new Error(`${chunk.file} is a Git LFS pointer, not real audio. Start a fresh task from latest cloud-mp4-transcription.`);
      }
      if (data.length < 100000) {
        throw new Error(`${chunk.file} is unexpectedly small (${data.length} bytes).`);
      }
    }
  }
  console.log(`Verified ${count} audio chunks (${(totalBytes / 1024 / 1024).toFixed(1)} MB).`);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
