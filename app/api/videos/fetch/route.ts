import { execFile } from 'child_process';
import { ytDlpPath, parseFormats, pickRecommended, isHttpUrl, ytDlpCommonArgs, ytDlpErrorMessage } from '@/lib/ytdlp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RawVideoInfo {
  title: string;
  webpage_url?: string;
  thumbnail?: string;
  duration?: number;
  uploader?: string;
  view_count?: number;
  upload_date?: string;
  description?: string;
  like_count?: number;
  formats?: Array<{
    format_id: string; ext: string; height?: number;
    filesize?: number; filesize_approx?: number;
    vcodec?: string; acodec?: string; abr?: number; tbr?: number;
  }>;
}

function fetchVideoInfo(url: string, format: string, allowPlaylist: boolean, whatsapp: boolean) {
  return new Promise<any[]>((resolve, reject) => {
    const args = [...ytDlpCommonArgs(), '--dump-json'];
    if (!allowPlaylist) args.push('--no-playlist');
    args.push(url);

    const proc = execFile(ytDlpPath(), args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[clypt] yt-dlp metadata failed for', url, '\n', String(stderr).slice(-2000) || err.message);
        reject(new Error(ytDlpErrorMessage(String(stderr), err.message.split('\n')[0])));
        return;
      }
      try {
        const lines = stdout.trim().split('\n').filter(Boolean);
        const videos = lines.map(line => {
          const info: RawVideoInfo = JSON.parse(line);
          return {
            url: info.webpage_url ?? url,
            title: info.title ?? url,
            thumbnail: info.thumbnail ?? null,
            duration: info.duration ?? null,
            uploader: info.uploader ?? null,
            viewCount: info.view_count ?? null,
            uploadDate: info.upload_date ?? null,
            description: info.description ? info.description.slice(0, 500) : null,
            likeCount: info.like_count ?? null,
            formats: parseFormats(info.formats ?? [], format),
            recommended: pickRecommended(info.formats ?? [], format, { whatsapp, duration: info.duration }),
            error: null,
          };
        });
        resolve(videos);
      } catch { reject(new Error('Failed to parse video info')); }
    });
    setTimeout(() => { proc.kill(); reject(new Error('Timed out fetching video info')); }, 30000);
  });
}

export async function POST(req: Request) {
  let body: { urls?: string[]; format?: string; allowPlaylist?: boolean; whatsapp?: boolean };
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { urls, format = 'mp4', allowPlaylist = false, whatsapp = false } = body;
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return Response.json({ error: 'urls array required' }, { status: 400 });
  }

  const dedupedUrls = [...new Set(urls.map((u: string) => u.trim()).filter(Boolean))];
  const rawResults = await Promise.all(
    dedupedUrls.map(async (url) => {
      try {
        if (!isHttpUrl(url)) throw new Error('Invalid link: it must start with http:// or https://');
        return await fetchVideoInfo(url, format, !!allowPlaylist, !!whatsapp);
      } catch (err) {
        return [{
          url, title: url, thumbnail: null, duration: null, uploader: null,
          formats: [], error: err instanceof Error ? err.message : 'Failed to fetch video info',
        }];
      }
    })
  );

  const results = rawResults.flat();
  return Response.json(results);
}
