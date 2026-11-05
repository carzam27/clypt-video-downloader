import fs from 'fs';
import { Readable } from 'stream';
import { rejectUnlessAuthorized } from '@/lib/api-auth';
import { quickDownload } from '@/lib/quick-download';
import { cleanOldTempFiles, isHttpUrl } from '@/lib/ytdlp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Pulls the first http(s) URL out of whatever the client sent (JSON, form or plain text; Shortcuts can send any). */
async function readUrl(req: Request): Promise<{ url: string | null; whatsapp: boolean }> {
  const type = req.headers.get('content-type') ?? '';
  let url: string | undefined;
  let whatsapp: unknown = true;

  if (type.includes('application/json')) {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    url = typeof body.url === 'string' ? body.url : undefined;
    whatsapp = body.whatsapp ?? true;
  } else if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const form = await req.formData().catch(() => null);
    url = form?.get('url')?.toString();
    whatsapp = form?.get('whatsapp') ?? true;
  } else {
    url = await req.text().catch(() => '');
  }

  const found = url?.match(/https?:\/\/\S+/)?.[0];
  return { url: found && isHttpUrl(found) ? found : null, whatsapp: whatsapp !== false && whatsapp !== 'false' && whatsapp !== '0' };
}

/**
 * Single-request download for iOS Shortcuts: POST a link, get the video file back.
 * Auth: `Authorization: Bearer <CLYPT_API_TOKEN>`.
 */
export async function POST(req: Request) {
  const denied = rejectUnlessAuthorized(req);
  if (denied) return denied;

  try { cleanOldTempFiles(); } catch {}

  const { url, whatsapp } = await readUrl(req);
  if (!url) return Response.json({ error: 'Send a link as JSON {"url": "..."} or as plain text.' }, { status: 400 });

  let file: { path: string; filename: string };
  try {
    file = await quickDownload(url, { whatsapp, signal: req.signal });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Download failed' }, { status: 502 });
  }

  const cleanup = () => { try { fs.unlinkSync(file.path); } catch {} };
  const stream = fs.createReadStream(file.path);
  stream.on('close', cleanup);
  stream.on('error', cleanup);

  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(fs.statSync(file.path).size),
      'Content-Disposition': 'inline; filename="clypt.mp4"',
      'Cache-Control': 'no-store',
    },
  });
}
