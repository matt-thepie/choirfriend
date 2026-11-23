/**
 * A tiny in-memory stand-in for the S3 API, enough for the storage adapter:
 * path-style GET / HEAD / PUT / DELETE of objects (with Range and
 * If-None-Match) and ListObjectsV2. No signature checking.
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

interface Stored {
  body: Buffer;
  contentType: string;
  etag: string;
}

export interface FakeS3 {
  endpoint: string;
  /** "bucket/key" → object. */
  objects: Map<string, Stored>;
  put(bucket: string, key: string, body: string | Buffer, contentType?: string): void;
  /** Every request seen, as "METHOD bucket/key". */
  requests: string[];
  close(): Promise<void>;
}

function xmlError(res: http.ServerResponse, status: number, code: string): void {
  res.writeHead(status, { 'Content-Type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
}

export async function startFakeS3(): Promise<FakeS3> {
  const objects = new Map<string, Stored>();
  const requests: string[] = [];
  const put = (bucket: string, key: string, body: string | Buffer, contentType = 'application/octet-stream'): void => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    objects.set(`${bucket}/${key}`, { body: buf, contentType, etag: `"${createHash('md5').update(buf).digest('hex')}"` });
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = decodeURIComponent(url.pathname.slice(1));
    const slash = path.indexOf('/');
    const bucket = slash === -1 ? path : path.slice(0, slash);
    const key = slash === -1 ? '' : path.slice(slash + 1);
    const id = `${bucket}/${key}`;
    requests.push(`${req.method} ${id}`);

    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const rows = [...objects.entries()]
        .filter(([k]) => k.startsWith(`${bucket}/${prefix}`))
        .map(([k, o]) => `<Contents><Key>${k.slice(bucket.length + 1)}</Key><Size>${o.body.length}</Size><ETag>${o.etag}</ETag></Contents>`);
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><IsTruncated>false</IsTruncated>${rows.join('')}</ListBucketResult>`);
      return;
    }
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        put(bucket, key, Buffer.concat(chunks), req.headers['content-type'] ?? undefined);
        res.writeHead(200, { ETag: objects.get(id)!.etag });
        res.end();
      });
      return;
    }
    if (req.method === 'DELETE') {
      objects.delete(id);
      res.writeHead(204);
      res.end();
      return;
    }
    const o = objects.get(id);
    if (!o) {
      if (req.method === 'HEAD') {
        res.writeHead(404);
        res.end();
      } else xmlError(res, 404, 'NoSuchKey');
      return;
    }
    if (req.headers['if-none-match'] === o.etag) {
      res.writeHead(304, { ETag: o.etag });
      res.end();
      return;
    }
    const headers: Record<string, string | number> = {
      'Content-Type': o.contentType,
      ETag: o.etag,
      'Last-Modified': new Date(0).toUTCString(),
      'Accept-Ranges': 'bytes',
    };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (m && req.method === 'GET') {
      const size = o.body.length;
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size) return xmlError(res, 416, 'InvalidRange');
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      res.end(o.body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': o.body.length });
    res.end(req.method === 'HEAD' ? undefined : o.body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    put,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
