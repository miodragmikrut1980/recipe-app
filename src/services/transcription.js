import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function runMediaCommand(binary, args) {
  try { await run(binary, args, { timeout: 120000, maxBuffer: 1024 * 1024 }); }
  catch (err) {
    const detail = String(err.stderr || err.message).slice(0, 500);
    throw new Error(`${binary} obrada nije uspela: ${detail}`);
  }
}

export async function extractAudio(videoPath) {
  const audioPath = path.join(os.tmpdir(), `${randomUUID()}.mp3`);
  try {
    await runMediaCommand('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', videoPath, '-vn', '-acodec', 'libmp3lame', '-b:a', '64k', '-ac', '1', '-y', audioPath]);
    return audioPath;
  } catch (err) {
    fs.rm(audioPath, { force: true }, () => {});
    throw err;
  }
}

async function videoDuration(videoPath) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath], { timeout: 30000 });
  const duration = Number.parseFloat(stdout);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Trajanje videa nije moguće utvrditi');
  return duration;
}

export async function extractFrames(videoPath, count = 4) {
  const dir = path.join(os.tmpdir(), randomUUID());
  await fs.promises.mkdir(dir, { mode: 0o700 });
  try {
    const duration = await videoDuration(videoPath);
    const frames = Array.from({ length: count }, (_, index) => path.join(dir, `frame-${index + 1}.jpg`));
    await Promise.all(frames.map((frame, index) => {
      const second = Math.max(0, Math.min(duration - 0.05, duration * ((index + 1) / (count + 1))));
      return runMediaCommand('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', second.toFixed(3), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '3', '-y', frame]);
    }));
    return frames;
  } catch (err) {
    await fs.promises.rm(dir, { recursive: true, force: true });
    throw err;
  }
}

export async function transcribeVideo(filePath) {
  let audioPath = null;
  try {
    audioPath = await extractAudio(filePath);
    const transcription = await openai.audio.transcriptions.create({ file: fs.createReadStream(audioPath), model: 'whisper-1' });
    return transcription.text;
  } finally {
    if (audioPath) fs.rm(audioPath, { force: true }, () => {});
  }
}
