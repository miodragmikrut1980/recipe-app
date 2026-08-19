import OpenAI from 'openai';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Izvlaci audio track iz videa (mp3, mono, 64kbps) — video od 50MB postane
 * audio od ~2MB, sto resava Whisper-ov limit od 25MB i ubrzava obradu.
 * Zahteva ffmpeg instaliran na serveru (Railway/Render nixpacks ga imaju;
 * lokalno: apt install ffmpeg / brew install ffmpeg).
 */
export function extractAudio(videoPath) {
  const audioPath = path.join(os.tmpdir(), `${randomUUID()}.mp3`);
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('64k')
      .audioChannels(1)
      .save(audioPath)
      .on('end', () => resolve(audioPath))
      .on('error', (err) => reject(new Error(`Ekstrakcija audio zapisa nije uspela: ${err.message}`)));
  });
}

/**
 * Izvlaci do 4 kadra iz videa (za fallback kad nema govora — recepti koji
 * su samo tekst na ekranu). Vraca listu putanja do JPG fajlova.
 */
export function extractFrames(videoPath, count = 4) {
  const dir = path.join(os.tmpdir(), randomUUID());
  fs.mkdirSync(dir);
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .screenshots({ count, folder: dir, filename: 'frame-%i.jpg', size: '720x?' })
      .on('end', () => {
        const frames = fs.readdirSync(dir).map((f) => path.join(dir, f));
        resolve(frames);
      })
      .on('error', (err) => reject(new Error(`Izvlacenje kadrova nije uspelo: ${err.message}`)));
  });
}

export async function transcribeVideo(filePath) {
  let audioPath = null;
  try {
    audioPath = await extractAudio(filePath);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      // Bez "language" — Whisper sam detektuje (radi za srpski i engleski)
    });
    return transcription.text;
  } finally {
    if (audioPath) fs.unlink(audioPath, () => {});
  }
}
