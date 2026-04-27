#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const SEGMENT_SECONDS = 600;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}\n${stderr}`));
    });
  });
}

async function walk(dir, predicate, out = []) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === ".transcribe_work" || entry.name === "audio_chunks") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, predicate, out);
    else if (entry.isFile() && predicate(full)) out.push(full);
  }
  return out;
}

async function duration(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    file
  ]);
  return Number(JSON.parse(stdout).format?.duration || 0);
}

async function main() {
  const root = process.cwd();
  await run("ffmpeg", ["-version"]);
  await run("ffprobe", ["-version"]);
  const videos = await walk(root, (p) => p.toLowerCase().endsWith(".mp4"));
  const manifest = {
    created_at: new Date().toISOString(),
    segment_seconds: SEGMENT_SECONDS,
    audio_format: "mp3 mono 16kHz 48kbps",
    videos: []
  };
  for (const video of videos) {
    const relVideo = path.relative(root, video).replace(/\\/g, "/");
    const hash = createHash("sha1").update(relVideo).digest("hex").slice(0, 12);
    const outDir = path.join(root, "audio_chunks", hash);
    await fsp.rm(outDir, { recursive: true, force: true });
    await fsp.mkdir(outDir, { recursive: true });
    const pattern = path.join(outDir, "chunk_%04d.mp3");
    console.log(`Segmenting ${relVideo}`);
    await run("ffmpeg", [
      "-y",
      "-i", video,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-b:a", "48k",
      "-f", "segment",
      "-segment_time", String(SEGMENT_SECONDS),
      "-reset_timestamps", "1",
      pattern
    ]);
    const dur = await duration(video);
    const chunkFiles = (await fsp.readdir(outDir))
      .filter((name) => /^chunk_\d+\.mp3$/.test(name))
      .sort();
    manifest.videos.push({
      video: relVideo,
      duration_seconds: dur,
      chunks: chunkFiles.map((name, index) => ({
        index,
        file: path.relative(root, path.join(outDir, name)).replace(/\\/g, "/"),
        start: index * SEGMENT_SECONDS,
        end: Math.min(dur, (index + 1) * SEGMENT_SECONDS)
      }))
    });
  }
  await fsp.writeFile(path.join(root, "audio_chunks_manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`Prepared chunks for ${manifest.videos.length} videos.`);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
