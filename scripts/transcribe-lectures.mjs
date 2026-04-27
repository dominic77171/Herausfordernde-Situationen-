#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const AUDIO_LIMIT_BYTES = 24 * 1024 * 1024;
const DEFAULT_SEGMENT_SECONDS = 600;

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    model: "gpt-4o-transcribe",
    language: "de",
    dryRun: false,
    force: false,
    segmentSeconds: DEFAULT_SEGMENT_SECONDS
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--root") args.root = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--language") args.language = argv[++i];
    else if (a === "--segment-seconds") args.segmentSeconds = Number(argv[++i]);
    else if (a === "--force") args.force = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/transcribe-lectures.mjs [--root <folder>] [--dry-run]",
    "",
    "Environment:",
    "  OPENAI_API_KEY must be set unless --dry-run is used.",
    "",
    "Options:",
    "  --root <folder>            Project root to scan; default current directory",
    "  --model <model>            Transcription model; default gpt-4o-transcribe",
    "  --language <code>          Spoken language hint; default de",
    "  --segment-seconds <n>      Audio chunk length; default 600",
    "  --force                    Re-transcribe videos with existing transcripts",
    "  --dry-run                  Build matching report without uploading audio"
  ].join("\n");
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
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

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, predicate, out = []) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".transcribe_work") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, predicate, out);
    else if (entry.isFile() && predicate(full)) out.push(full);
  }
  return out;
}

function normalizeText(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[_\-.,;()[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s) {
  const stop = new Set(["fw51", "2026", "pdf", "mp4", "pptx", "folie", "folien", "praesentation", "präsentation", "video", "teil", "selbststudium"]);
  return normalizeText(s).split(" ").filter((t) => t.length > 2 && !stop.has(t));
}

function jaccard(a, b) {
  const aa = new Set(a);
  const bb = new Set(b);
  if (!aa.size || !bb.size) return 0;
  let hit = 0;
  for (const t of aa) if (bb.has(t)) hit += 1;
  return hit / new Set([...aa, ...bb]).size;
}

function commonPathDepth(a, b) {
  const aa = path.dirname(a).split(path.sep);
  const bb = path.dirname(b).split(path.sep);
  let n = 0;
  while (n < aa.length && n < bb.length && aa[n] === bb[n]) n += 1;
  return n;
}

function matchSlides(video, pdfs, root) {
  const mapped = globalThis.lectureSlideMap?.get(path.relative(root, video));
  if (mapped?.length) {
    return mapped.map((item) => ({
      path: path.join(root, item.path),
      score: Number(item.confidence ?? item.score ?? 1)
    }));
  }
  const videoTokens = tokens(`${path.basename(video)} ${path.dirname(path.relative(root, video))}`);
  const videoBase = normalizeText(path.basename(video, path.extname(video)));
  const scored = pdfs.map((pdf) => {
    const pdfTokens = tokens(`${path.basename(pdf)} ${path.dirname(path.relative(root, pdf))}`);
    const pdfBase = normalizeText(path.basename(pdf, path.extname(pdf)));
    const sameDir = path.dirname(video) === path.dirname(pdf) ? 0.18 : 0;
    const depth = commonPathDepth(video, pdf);
    const dirScore = Math.min(0.18, depth * 0.025);
    const nameScore = jaccard(videoTokens, pdfTokens) * 0.46;
    const exactBoost = videoBase === pdfBase ? 0.38 : (videoBase.includes(pdfBase) || pdfBase.includes(videoBase) ? 0.18 : 0);
    const slideHint = /folien|folie|ppp|powerpoint|präsentation|praesentation|selbststudium/i.test(pdf) ? 0.06 : 0;
    const score = Math.min(1, exactBoost + sameDir + dirScore + nameScore + slideHint);
    return { path: pdf, score };
  }).sort((a, b) => b.score - a.score);
  return scored.filter((x) => x.score >= 0.25).slice(0, 5);
}

async function loadSlideMap(root) {
  const mapPath = path.join(root, "lecture_slide_map.json");
  if (!await pathExists(mapPath)) return new Map();
  const raw = JSON.parse(await fsp.readFile(mapPath, "utf8"));
  const map = new Map();
  for (const item of raw.videos || []) {
    map.set(item.video, item.related_slides || []);
  }
  return map;
}

async function ffprobeDuration(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    file
  ]);
  const parsed = JSON.parse(stdout);
  return Number(parsed.format?.duration || 0);
}

async function segmentAudio(video, workDir, segmentSeconds) {
  await fsp.mkdir(workDir, { recursive: true });
  const pattern = path.join(workDir, "chunk_%04d.mp3");
  await run("ffmpeg", [
    "-y",
    "-i", video,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-b:a", "48k",
    "-f", "segment",
    "-segment_time", String(segmentSeconds),
    "-reset_timestamps", "1",
    pattern
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const chunks = (await fsp.readdir(workDir))
    .filter((name) => /^chunk_\d+\.mp3$/.test(name))
    .sort()
    .map((name, index) => ({ file: path.join(workDir, name), index }));
  for (const chunk of chunks) {
    const stat = await fsp.stat(chunk.file);
    if (stat.size > AUDIO_LIMIT_BYTES) {
      throw new Error(`Audio chunk is too large for OpenAI upload: ${chunk.file} (${stat.size} bytes)`);
    }
  }
  return chunks;
}

async function findPrebuiltChunks(root, video) {
  const manifestPath = path.join(root, "audio_chunks_manifest.json");
  if (!await pathExists(manifestPath)) return null;
  const manifestText = (await fsp.readFile(manifestPath, "utf8")).replace(/^\uFEFF/, "");
  const manifest = JSON.parse(manifestText);
  const relVideo = path.relative(root, video).replace(/\\/g, "/");
  const entry = (manifest.videos || []).find((v) => v.video === relVideo);
  if (!entry) return null;
  const chunks = [];
  for (const chunk of entry.chunks || []) {
    const file = path.join(root, chunk.file);
    if (!await pathExists(file)) throw new Error(`Missing prebuilt audio chunk: ${chunk.file}`);
    const stat = await fsp.stat(file);
    if (stat.size > AUDIO_LIMIT_BYTES) {
      throw new Error(`Prebuilt audio chunk is too large for OpenAI upload: ${chunk.file} (${stat.size} bytes)`);
    }
    chunks.push({
      file,
      index: chunk.index,
      start: chunk.start,
      end: chunk.end
    });
  }
  return {
    duration: entry.duration_seconds,
    chunks: chunks.sort((a, b) => a.index - b.index)
  };
}

async function transcribeChunk(chunk, args) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const bytes = await fsp.readFile(chunk.file);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/mpeg" }), path.basename(chunk.file));
  form.append("model", args.model);
  form.append("response_format", "json");
  if (args.language) form.append("language", args.language);
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAI transcription failed: HTTP ${response.status}: ${text}`);
  try {
    const json = JSON.parse(text);
    return json.text || "";
  } catch {
    return text;
  }
}

function rel(from, to) {
  return `./${path.relative(path.dirname(from), to).replace(/\\/g, "/")}`;
}

function yamlString(s) {
  return JSON.stringify(String(s || ""));
}

function formatTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function wrapVttText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().match(/.{1,90}(\s|$)/g)?.join("\n").trim() || "";
}

async function writeTranscript(video, root, relatedSlides, chunks, duration, args) {
  const base = video.replace(/\.mp4$/i, "");
  const mdPath = `${base}.transcript.md`;
  const jsonPath = `${base}.transcript.json`;
  const vttPath = `${base}.transcript.vtt`;
  const sha = createHash("sha256").update(await fsp.readFile(video)).digest("hex");
  const fullText = chunks.map((c) => c.text).join("\n\n").trim();
  const relatedYaml = relatedSlides.length
    ? relatedSlides.map((s) => `  - path: ${yamlString(rel(mdPath, s.path))}\n    confidence: ${s.score.toFixed(2)}`).join("\n")
    : "  []";
  const md = [
    "---",
    "type: lecture_transcript",
    `source_video: ${yamlString(rel(mdPath, video))}`,
    `source_video_sha256: ${yamlString(sha)}`,
    `duration_seconds: ${Math.round(duration)}`,
    `transcription_model: ${yamlString(args.model)}`,
    `language: ${yamlString(args.language)}`,
    "related_slides:",
    relatedYaml,
    `created_at: ${yamlString(new Date().toISOString())}`,
    "---",
    "",
    `# ${path.basename(video)}`,
    "",
    "## Zugeordnete Folien",
    "",
    ...(relatedSlides.length ? relatedSlides.map((s) => `- [${path.basename(s.path)}](${rel(mdPath, s.path)}) (${s.score.toFixed(2)})`) : ["- Keine passende Folien-Datei gefunden."]),
    "",
    "## Transkript",
    "",
    fullText,
    ""
  ].join("\n");
  const vtt = [
    "WEBVTT",
    "",
    ...chunks.flatMap((c, i) => [
      String(i + 1),
      `${formatTime(c.start)} --> ${formatTime(c.end)}`,
      wrapVttText(c.text),
      ""
    ])
  ].join("\n");
  const json = {
    type: "lecture_transcript",
    source_video: path.relative(root, video),
    source_video_sha256: sha,
    duration_seconds: duration,
    transcription_model: args.model,
    language: args.language,
    related_slides: relatedSlides.map((s) => ({ path: path.relative(root, s.path), confidence: Number(s.score.toFixed(3)) })),
    chunks,
    transcript_text: fullText,
    created_at: new Date().toISOString()
  };
  await fsp.writeFile(mdPath, md, "utf8");
  await fsp.writeFile(vttPath, vtt, "utf8");
  await fsp.writeFile(jsonPath, JSON.stringify(json, null, 2), "utf8");
  return { mdPath, jsonPath, vttPath, bytes: Buffer.byteLength(fullText, "utf8") };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const root = path.resolve(args.root);
  globalThis.lectureSlideMap = await loadSlideMap(root);
  const mp4s = await walk(root, (p) => p.toLowerCase().endsWith(".mp4"));
  const pdfs = await walk(root, (p) => p.toLowerCase().endsWith(".pdf"));
  const plan = mp4s.map((video) => ({
    video,
    relatedSlides: matchSlides(video, pdfs, root)
  }));
  if (args.dryRun) {
    const report = { root, video_count: mp4s.length, pdf_count: pdfs.length, plan };
    await fsp.writeFile(path.join(root, "lecture_transcription_plan.json"), JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for transcription");
  const hasPrebuiltChunks = await pathExists(path.join(root, "audio_chunks_manifest.json"));
  if (!hasPrebuiltChunks) {
    await run("ffmpeg", ["-version"]);
    await run("ffprobe", ["-version"]);
  }

  const index = {
    created_at: new Date().toISOString(),
    root,
    model: args.model,
    language: args.language,
    total_videos: plan.length,
    done: 0,
    errors: [],
    transcripts: []
  };
  const indexPath = path.join(root, "lecture_transcript_index.json");
  for (let i = 0; i < plan.length; i += 1) {
    const item = plan[i];
    const base = item.video.replace(/\.mp4$/i, "");
    if (!args.force && await pathExists(`${base}.transcript.md`)) {
      console.log(`[skip ${i + 1}/${plan.length}] ${path.relative(root, item.video)}`);
      continue;
    }
    try {
      console.log(`[video ${i + 1}/${plan.length}] ${path.relative(root, item.video)}`);
      const prebuilt = await findPrebuiltChunks(root, item.video);
      const duration = prebuilt?.duration ?? await ffprobeDuration(item.video);
      const workDir = path.join(root, ".transcribe_work", createHash("sha1").update(item.video).digest("hex").slice(0, 12));
      if (!prebuilt) await fsp.rm(workDir, { recursive: true, force: true });
      const audioChunks = prebuilt?.chunks ?? await segmentAudio(item.video, workDir, args.segmentSeconds);
      const chunks = [];
      for (const chunk of audioChunks) {
        const start = chunk.start ?? chunk.index * args.segmentSeconds;
        const end = chunk.end ?? Math.min(duration, (chunk.index + 1) * args.segmentSeconds);
        console.log(`  [chunk ${chunk.index + 1}/${audioChunks.length}] ${formatTime(start)}-${formatTime(end)}`);
        const text = await transcribeChunk(chunk, args);
        chunks.push({ index: chunk.index, start, end, text });
        if (!prebuilt) await fsp.writeFile(`${chunk.file}.txt`, text, "utf8");
      }
      const written = await writeTranscript(item.video, root, item.relatedSlides, chunks, duration, args);
      if (!prebuilt) await fsp.rm(workDir, { recursive: true, force: true });
      index.done += 1;
      index.transcripts.push({
        video: path.relative(root, item.video),
        transcript_md: path.relative(root, written.mdPath),
        transcript_json: path.relative(root, written.jsonPath),
        transcript_vtt: path.relative(root, written.vttPath),
        related_slides: item.relatedSlides.map((s) => ({ path: path.relative(root, s.path), confidence: Number(s.score.toFixed(3)) }))
      });
      await fsp.writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
    } catch (error) {
      index.errors.push({ video: path.relative(root, item.video), error: String(error.message || error) });
      await fsp.writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
      console.error(`[error] ${path.relative(root, item.video)}: ${error.message || error}`);
    }
  }
  console.log(`Done: ${index.done}/${index.total_videos}, errors: ${index.errors.length}`);
  if (index.errors.length) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
