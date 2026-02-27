/**
 * Audio transcription via OpenAI Whisper API.
 *
 * Requires OPENAI_API_KEY in environment.
 * Supports: .ogg, .opus, .m4a, .mp3, .mp4, .wav, .webm
 *
 * Returns null if API key is missing or transcription fails.
 * No external dependencies — uses Node built-in fetch + FormData.
 */

import { readFileSync, existsSync } from 'fs';
import { basename, extname } from 'path';
import { createLogger } from './logger.js';

const log = createLogger('transcribe');

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const SUPPORTED_EXTENSIONS = new Set(['.ogg', '.opus', '.m4a', '.mp3', '.mp4', '.wav', '.webm', '.flac']);

// MIME types for multipart upload
const MIME_TYPES = {
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.mp4': 'audio/mp4',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
};

/**
 * Transcribe an audio file using OpenAI Whisper.
 *
 * @param {string} filePath - Absolute path to audio file
 * @param {object} [options]
 * @param {string} [options.language] - BCP-47 language code hint (e.g. 'he', 'en')
 * @param {string} [options.model] - Whisper model, defaults to 'whisper-1'
 * @returns {Promise<{text: string, language: string|null}|null>} transcript or null
 */
export async function transcribeAudio(filePath, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log.debug('No OPENAI_API_KEY set — transcription unavailable');
    return null;
  }

  if (!existsSync(filePath)) {
    log.warn({ filePath }, 'Audio file not found');
    return null;
  }

  const ext = extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    log.warn({ ext }, 'Unsupported audio format for transcription');
    return null;
  }

  const model = options.model || 'whisper-1';
  const fileName = basename(filePath);
  const mimeType = MIME_TYPES[ext] || 'audio/ogg';

  try {
    const audioBuffer = readFileSync(filePath);
    const audioBlob = new Blob([audioBuffer], { type: mimeType });

    const form = new FormData();
    form.append('file', audioBlob, fileName);
    form.append('model', model);
    form.append('response_format', 'verbose_json');
    if (options.language) form.append('language', options.language);

    log.info({ filePath: fileName, size: audioBuffer.length, model }, 'Transcribing audio');

    const response = await fetch(WHISPER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      log.warn({ status: response.status, body: errText.slice(0, 200) }, 'Whisper API error');
      return null;
    }

    const result = await response.json();
    const text = (result.text || '').trim();
    const language = result.language || null;

    log.info({ chars: text.length, language }, 'Transcription complete');
    return { text, language };
  } catch (err) {
    log.warn({ err: err.message }, 'Transcription failed');
    return null;
  }
}

/**
 * Check if transcription is available (API key configured).
 * @returns {boolean}
 */
export function isTranscriptionAvailable() {
  return Boolean(process.env.OPENAI_API_KEY);
}
