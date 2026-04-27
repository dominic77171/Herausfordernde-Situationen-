# Codex Cloud Task

This branch contains only the MP4 lecture videos, transcript pipeline, and slide-path metadata.

## Goal

Transcribe all MP4 lecture videos and commit the generated transcript artifacts.

## Steps

1. Ensure `OPENAI_API_KEY` is available in the environment.
2. Ensure this checkout is at commit `fa39a05` or newer. Older task branches contain Git LFS pointer MP3 files and cannot work.
3. Run:

   ```bash
   npm run verify-audio
   ```

   This must report real MP3 chunk files, not Git LFS pointers.
4. Use the prebuilt MP3 chunks from `audio_chunks_manifest.json`; do not install or require `ffmpeg` unless the chunks are missing.
5. Run:

   ```bash
   npm run transcribe
   ```

6. Verify `lecture_transcript_index.json` reports all videos completed and no errors.
7. Commit generated files:
   - `*.transcript.md`
   - `*.transcript.json`
   - `*.transcript.vtt`
   - `lecture_transcript_index.json`

The transcript sidecars contain `related_slides` metadata from `lecture_slide_map.json`.
