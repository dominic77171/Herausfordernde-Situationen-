# Codex Cloud Task

This branch contains only the MP4 lecture videos, transcript pipeline, and slide-path metadata.

## Goal

Transcribe all MP4 lecture videos and commit the generated transcript artifacts.

## Steps

1. Ensure `OPENAI_API_KEY` is available in the environment.
2. Use the prebuilt MP3 chunks from `audio_chunks_manifest.json`; do not install or require `ffmpeg` unless the chunks are missing.
3. Run:

   ```bash
   npm run transcribe
   ```

4. Verify `lecture_transcript_index.json` reports all videos completed and no errors.
5. Commit generated files:
   - `*.transcript.md`
   - `*.transcript.json`
   - `*.transcript.vtt`
   - `lecture_transcript_index.json`

The transcript sidecars contain `related_slides` metadata from `lecture_slide_map.json`.
