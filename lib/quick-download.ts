import { execFile, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';
import {
  ytDlpPath, ytDlpCommonArgs, ytDlpErrorMessage, ffmpegLocationArgs, pickRecommended,
  ensureQuickTimeCompatible, type RawFormat,
} from '@/lib/ytdlp';

const INFO_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

function fetchInfo(url: string): Promise<{ formats?: RawFormat[]; duration?: number }> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      ytDlpPath(), [...ytDlpCommonArgs(), '--dump-json', '--no-playlist', url],
      { maxBuffer: 10 * 1024 * 1024, timeout: INFO_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) { reject(new Error(ytDlpErrorMessage(String(stderr), err.message.split('\n')[0]))); return; }
        try { resolve(JSON.parse(stdout.trim().split('\n')[0])); } catch { reject(new Error('Failed to parse video info')); }
      },
    );
    proc.on('error', (e) => reject(new Error(`Cannot run yt-dlp: ${e.message}`)));
  });
}

/**
 * Downloads one video as an mp4 that plays everywhere (H.264/AAC) and returns the file path.
 * Picks the quality itself (same rule as the web UI); `whatsapp` caps it at 720p / ~15 MB.
 * The caller owns the file and must delete it.
 */
export async function quickDownload(url: string, opts: { whatsapp: boolean; signal?: AbortSignal }): Promise<{ path: string; filename: string }> {
  const info = await fetchInfo(url);
  const rec = pickRecommended(info.formats ?? [], 'mp4', { whatsapp: opts.whatsapp, duration: info.duration });

  const jobId = randomUUID();
  const template = path.join(os.tmpdir(), `clypt-%(title).50s-${jobId}.%(ext)s`);
  const args = [
    ...ytDlpCommonArgs(), '--no-playlist', '-f', rec.formatId, '-o', template,
    '--print', 'after_move:filepath', '--newline', ...ffmpegLocationArgs(),
    '--merge-output-format', 'mp4', url,
  ];

  const file = await new Promise<string>((resolve, reject) => {
    const proc = spawn(ytDlpPath(), args);
    let stderr = '';
    let out = '';
    let outputPath = '';
    proc.stdout.on('data', (c: Buffer) => {
      out += c.toString();
      const lines = out.split('\n');
      out = lines.pop() ?? '';
      for (const l of lines) if (l.trim() && fs.existsSync(l.trim())) outputPath = l.trim();
    });
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    const kill = () => { try { proc.kill(); } catch {} };
    const timer = setTimeout(() => { kill(); reject(new Error('Download timed out')); }, DOWNLOAD_TIMEOUT_MS);
    opts.signal?.addEventListener('abort', () => { clearTimeout(timer); kill(); reject(new Error('Request cancelled')); });
    proc.on('error', (e) => { clearTimeout(timer); reject(new Error(`Cannot run yt-dlp: ${e.message}`)); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && outputPath && fs.existsSync(outputPath)) resolve(outputPath);
      else {
        console.error(`[clypt] quick download failed (exit ${code}) for ${url}\n${stderr.slice(-2000)}`);
        reject(new Error(ytDlpErrorMessage(stderr, code === 0 ? 'yt-dlp finished but produced no output file' : `Download failed (exit ${code})`)));
      }
    });
  });

  let finalPath = file;
  try {
    finalPath = await ensureQuickTimeCompatible(file, { whatsapp: opts.whatsapp });
  } catch (err) {
    console.error('[clypt] H.264 re-encode failed, serving original:', err);
  }
  return { path: finalPath, filename: path.basename(finalPath) };
}
