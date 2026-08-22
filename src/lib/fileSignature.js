import fs from 'node:fs';
import { HttpError } from './httpError.js';

function startsWith(buffer, bytes, offset = 0) {
  return bytes.every((value, index) => buffer[offset + index] === value);
}

function ascii(buffer, start, end) {
  return buffer.subarray(start, end).toString('ascii');
}

export function detectFileKind(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(buffer, 0, 4) === 'GIF8') return 'image/gif';
  if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(buffer, 4, 8) === 'ftyp') return 'video/mp4';
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 12) === 'AVI ') return 'video/x-msvideo';
  return null;
}

export function verifyUploadedFile(filePath, expectedKind) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(32);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const detected = detectFileKind(buffer.subarray(0, bytesRead));
    const valid = expectedKind === 'image' ? detected?.startsWith('image/') : detected?.startsWith('video/');
    if (!valid) throw new HttpError(415, `Sadržaj fajla nije validan ${expectedKind === 'image' ? 'format slike' : 'video format'}`);
    return detected;
  } finally {
    fs.closeSync(descriptor);
  }
}
