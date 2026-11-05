import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';

/**
 * Resolves the path to the yt-dlp binary.
 * If bundled binary exists but is not executable (e.g. read-only filesystem in Lambda/Amplify),
 * it copies it to /tmp/yt-dlp, chmods it, and executes it from there.
 */
export function ytDlpPath(): string {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;

  const bundled = path.join(
    process.cwd(),
    'bin',
    process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  );

  if (fs.existsSync(bundled)) {
    if (process.platform === 'win32') {
      return bundled;
    }
    // Check if the bundled binary is executable
    try {
      fs.accessSync(bundled, fs.constants.X_OK);
      return bundled;
    } catch {
      // Not executable (common in AWS Lambda/Amplify deployment archives)
      const tmpPath = path.join(os.tmpdir(), 'yt-dlp');
      try {
        const bundledStats = fs.statSync(bundled);
        let shouldCopy = true;
        if (fs.existsSync(tmpPath)) {
          const tmpStats = fs.statSync(tmpPath);
          if (tmpStats.size === bundledStats.size) {
            shouldCopy = false;
          }
        }
        if (shouldCopy) {
          fs.copyFileSync(bundled, tmpPath);
        }
        fs.chmodSync(tmpPath, 0o755);
        return tmpPath;
      } catch (err) {
        console.error('Failed to copy and chmod yt-dlp to /tmp:', err);
        return bundled;
      }
    }
  }

  return 'yt-dlp';
}

/**
 * Resolves the path to the ffmpeg binary.
 * If bundled binary exists but is not executable, it copies it to /tmp/ffmpeg,
 * chmods it, and executes it from there.
 */
export function ffmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;

  const bundled = path.join(
    process.cwd(),
    'bin',
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  );

  if (fs.existsSync(bundled)) {
    if (process.platform === 'win32') {
      return bundled;
    }
    // Check if the bundled binary is executable
    try {
      fs.accessSync(bundled, fs.constants.X_OK);
      return bundled;
    } catch {
      // Not executable
      const tmpPath = path.join(os.tmpdir(), 'ffmpeg');
      try {
        const bundledStats = fs.statSync(bundled);
        let shouldCopy = true;
        if (fs.existsSync(tmpPath)) {
          const tmpStats = fs.statSync(tmpPath);
          if (tmpStats.size === bundledStats.size) {
            shouldCopy = false;
          }
        }
        if (shouldCopy) {
          fs.copyFileSync(bundled, tmpPath);
        }
        fs.chmodSync(tmpPath, 0o755);
        return tmpPath;
      } catch (err) {
        console.error('Failed to copy and chmod ffmpeg to /tmp:', err);
        return bundled;
      }
    }
  }

  return 'ffmpeg';
}

const COOKIES_FILE = path.join(os.tmpdir(), 'ytdlp-cookies.txt'); // not `clypt-*`: cleanOldTempFiles would delete it
let cookiesWritten = false;

/**
 * CLYPT_COOKIES holds a Netscape cookies.txt (raw or base64) so logged-in sessions can be used on hosts with no
 * persistent disk. It is written once per process to tmp with owner-only permissions. Returns the file path or null.
 */
function cookiesFile(): string | null {
  const raw = process.env.CLYPT_COOKIES?.trim();
  if (!raw) return null;
  if (!cookiesWritten) {
    const text = raw.includes('\t') || raw.startsWith('#') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    fs.writeFileSync(COOKIES_FILE, text.endsWith('\n') ? text : text + '\n', { mode: 0o600 });
    cookiesWritten = true;
  }
  return COOKIES_FILE;
}

/**
 * Flags shared by every yt-dlp invocation.
 * - `--js-runtimes node`: recent yt-dlp needs a JS runtime to solve YouTube challenges (node is always present here).
 * - CLYPT_COOKIES: logged-in cookies for sites that block datacenter IPs (Instagram, YouTube).
 * - YTDLP_EXTRA_ARGS: space-separated extra flags.
 */
export function ytDlpCommonArgs(): string[] {
  const extra = (process.env.YTDLP_EXTRA_ARGS ?? '').split(/\s+/).filter(Boolean);
  const cookies = cookiesFile();
  return ['--js-runtimes', 'node', ...(cookies ? ['--cookies', cookies] : []), ...extra];
}

/**
 * `--ffmpeg-location` args. ffmpegPath() returns the bare name `ffmpeg` when it should come from
 * PATH; passing dirname('ffmpeg') (= '.') would make yt-dlp look in the cwd and miss it, so omit the flag then.
 */
export function ffmpegLocationArgs(): string[] {
  const p = ffmpegPath();
  return p.includes(path.sep) ? ['--ffmpeg-location', path.dirname(p)] : [];
}

const ERROR_HINTS: [RegExp, string][] = [
  [/sign in to confirm|not a bot|cookies|empty media response|login required/i, 'The site wants a logged-in session from this server. Set CLYPT_COOKIES (Netscape cookies.txt, raw or base64) on the server.'],
  [/ffmpeg|ffprobe/i, 'ffmpeg was not found on the server.'],
  [/private|login required|members-only|requires authentication/i, 'This video is private or needs a login.'],
  [/unsupported url/i, 'This link is not supported.'],
  [/unavailable|removed|does not exist|404/i, 'The video is unavailable or was removed.'],
  [/429|too many requests|rate.?limit/i, 'Rate limited by the site. Try again in a few minutes.'],
];

/** Picks the most useful error line from yt-dlp stderr (ERROR lines first, then warnings) and adds a hint for known causes. */
export function ytDlpErrorMessage(stderr: string, fallback: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('[download]'));
  const pick = (tag: string) => [...lines].reverse().find((l) => l.includes(tag));
  const errLine = pick('ERROR:');
  const warn = pick('WARNING:');
  const raw = errLine
    ? errLine.replace(/.*ERROR:\s*/, '')
    : warn ? `${fallback}: ${warn.replace(/.*WARNING:\s*/, '')}` : fallback;
  const hint = ERROR_HINTS.find(([re]) => re.test(raw))?.[1];
  return (hint ? `${hint} (${raw})` : raw).slice(0, 500);
}

interface MediaProbe { codec: string | null; shortSide: number | null; duration: number | null }

/** Reads codec/height/duration by parsing `ffmpeg -i` stderr; ffprobe is not guaranteed to be bundled. */
function probeMedia(file: string): Promise<MediaProbe> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-i', file]);
    let out = '';
    proc.stderr.on('data', (c: Buffer) => { out += c.toString(); });
    proc.on('error', () => resolve({ codec: null, shortSide: null, duration: null }));
    proc.on('close', () => {
      const dur = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const dims = out.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
      resolve({
        codec: out.match(/Video:\s*([a-z0-9_]+)/i)?.[1]?.toLowerCase() ?? null,
        shortSide: dims ? Math.min(Number(dims[1]), Number(dims[2])) : null,
        duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null,
      });
    });
  });
}

export const WHATSAPP_MAX_HEIGHT = 720;
const WHATSAPP_MAX_BYTES = 15 * 1024 * 1024; // WhatsApp's limit is 16 MB; keep a margin

/**
 * Makes an mp4 playable everywhere. QuickTime/Safari/iOS only play H.264/HEVC in an mp4, but sites like
 * Instagram serve VP9/AV1 DASH streams that yt-dlp merges into an .mp4 that QuickTime rejects, so those are
 * re-encoded to H.264/AAC. With `whatsapp`, the result is also capped at 720p and ~15 MB.
 * Returns the (possibly new) path; the original is removed after a successful re-encode.
 */
export async function ensureQuickTimeCompatible(file: string, opts: { whatsapp?: boolean } = {}): Promise<string> {
  const { codec, shortSide, duration } = await probeMedia(file);
  if (!codec) return file;

  const size = fs.statSync(file).size;
  const compatible = codec === 'h264' || codec === 'hevc';
  const fitsWhatsapp = !opts.whatsapp || (codec === 'h264' && size <= WHATSAPP_MAX_BYTES && (shortSide ?? 0) <= WHATSAPP_MAX_HEIGHT);
  if (compatible && fitsWhatsapp) return file;

  const vArgs = ['-c:v', 'libx264', '-preset', 'veryfast', '-threads', '2', '-crf', '23', '-pix_fmt', 'yuv420p'];
  if (opts.whatsapp) {
    // Cap the short side (so 9:16 clips stay 720x1280), keeping the aspect ratio.
    const m = WHATSAPP_MAX_HEIGHT;
    vArgs.push('-vf', `scale='if(gt(iw,ih),-2,min(${m},iw))':'if(gt(iw,ih),min(${m},ih),-2)'`);
    if (duration && duration > 0) {
      const kbps = Math.max(300, Math.floor(((WHATSAPP_MAX_BYTES * 8) / duration - 128_000) * 0.9 / 1000));
      vArgs.push('-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`);
    }
  }

  const out = file.replace(/\.[^.]+$/, '.h264.mp4');
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath(), [
      '-hide_banner', '-y', '-i', file, ...vArgs,
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out,
    ]);
    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    const t = setTimeout(() => { proc.kill(); reject(new Error('Re-encoding to H.264 timed out')); }, 5 * 60 * 1000);
    proc.on('error', (e) => { clearTimeout(t); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new Error('Re-encoding to H.264 failed: ' + stderr.slice(-200)));
    });
  });
  try { fs.unlinkSync(file); } catch {}
  return out;
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export type OutputFormat = 'mp4' | 'webm' | 'mp3' | 'm4a' | 'wav' | 'ogg' | 'gif';

export function isAudioFormat(fmt: string): boolean {
  return ['mp3', 'm4a', 'wav', 'ogg'].includes(fmt);
}

export interface RawFormat {
  format_id: string;
  format_note?: string;
  ext: string;
  height?: number;
  width?: number;
  filesize?: number;
  filesize_approx?: number;
  vcodec?: string;
  acodec?: string;
  abr?: number;
  tbr?: number;
}

export function parseFormats(rawFormats: RawFormat[], targetFormat: string) {
  if (isAudioFormat(targetFormat)) {
    return [{ formatId: 'bestaudio/best', quality: 'Best Audio', ext: targetFormat }];
  }

  const seen = new Set<string>();
  const out: { formatId: string; quality: string; ext: string; filesize?: number | null }[] = [];

  const videoFormats = rawFormats
    .filter((f) => f.vcodec && f.vcodec !== 'none' && f.height)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));

  for (const f of videoFormats) {
    const label = `${f.height}p`;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({
      formatId: `bestvideo[height<=${f.height}]+bestaudio/best[height<=${f.height}]`,
      quality: label,
      ext: targetFormat,
      filesize: f.filesize ?? f.filesize_approx ?? null,
    });
  }

  if (out.length === 0) {
    out.push({ formatId: 'bestvideo+bestaudio/best', quality: 'Best', ext: targetFormat });
  }

  return out;
}

export interface Recommended {
  formatId: string;
  label: string;
  height: number | null;
  sizeBytes: number | null;
}

/** yt-dlp selector: prefer H.264+AAC (plays everywhere, no re-encode) up to `maxHeight`, then anything up to it. */
export function autoFormatId(maxHeight: number): string {
  const h = `[height<=${maxHeight}]`;
  return `bv*[vcodec^=avc1]${h}+ba[acodec^=mp4a]/b[vcodec^=avc1]${h}/bv*${h}+ba/b${h}/b`;
}

/**
 * The one option to pre-select for a video: best resolution up to 1080p (720p in WhatsApp mode).
 * Audio targets use best audio; non-mp4 video targets keep the first parsed format.
 */
export function pickRecommended(
  rawFormats: RawFormat[],
  targetFormat: string,
  opts: { whatsapp?: boolean; duration?: number | null } = {}
): Recommended {
  if (isAudioFormat(targetFormat)) {
    return { formatId: 'bestaudio/best', label: 'Best audio', height: null, sizeBytes: null };
  }
  if (targetFormat !== 'mp4') {
    const first = parseFormats(rawFormats, targetFormat)[0];
    return { formatId: first.formatId, label: first.quality, height: null, sizeBytes: null };
  }

  const cap = opts.whatsapp ? WHATSAPP_MAX_HEIGHT : 1080;
  // Resolution is judged by the short side so vertical videos (9:16) count as e.g. 720p, not 1280p.
  const video = rawFormats.filter((f) => f.vcodec && f.vcodec !== 'none' && f.height);
  const portrait = video.some((f) => f.width && f.height && f.height > f.width);
  const shortOf = (f: RawFormat) => (f.width ? Math.min(f.width, f.height as number) : (f.height as number));
  const shorts = video.map(shortOf);
  const bestShort = shorts.length ? Math.max(...shorts.filter((h) => h <= cap), 0) || Math.min(...shorts) : null;
  const pick = bestShort ? video.find((f) => shortOf(f) === bestShort) : undefined;
  const bytes = pick?.filesize ?? pick?.filesize_approx
    ?? (pick?.tbr && opts.duration ? Math.round((pick.tbr * 1000 * opts.duration) / 8) : null);
  const maxLong = portrait ? Math.ceil((cap * 16) / 9) : cap;
  const best = bestShort;

  return {
    formatId: autoFormatId(best && pick?.height ? pick.height : maxLong),
    label: best ? `${best}p` : 'Best',
    height: best,
    sizeBytes: bytes ?? null,
  };
}

export function cleanOldTempFiles(): void {
  const tmpDir = os.tmpdir();
  const now = Date.now();
  const cutoff = 30 * 60 * 1000; // 30 minutes
  try {
    const files = fs.readdirSync(tmpDir);
    for (const file of files) {
      if (file.startsWith('clypt-')) {
        const filePath = path.join(tmpDir, file);
        try {
          const stats = fs.statSync(filePath);
          if (now - stats.mtimeMs > cutoff) {
            fs.unlinkSync(filePath);
          }
        } catch {}
      }
    }
  } catch (err) {
    console.error('Failed to clean old temp files:', err);
  }
}
