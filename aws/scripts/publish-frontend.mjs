// Upload public/ to the S3 website bucket, plus a generated config.js that points the
// browser at this stack's API Gateway endpoints.
// Usage: npm run publish
import fs from 'node:fs';
import path from 'node:path';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { stackOutputs, ROOT_DIR } from './stack.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
}

const out = await stackOutputs();
const bucket = out.FrontendBucketName;
const s3 = new S3Client({});
const publicDir = path.join(ROOT_DIR, 'public');

const config = `window.QUIBBLE_CONFIG = ${JSON.stringify({ apiUrl: out.HttpApiUrl, wsUrl: out.WebSocketUrl }, null, 2)};\n`;
const uploads = [{ key: 'config.js', body: config, type: TYPES['.js'] }];
for (const file of walk(publicDir)) {
  const key = path.relative(publicDir, file).split(path.sep).join('/');
  if (key === 'config.js') continue;
  uploads.push({ key, body: fs.readFileSync(file), type: TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
}

for (const u of uploads) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: u.key,
    Body: u.body,
    ContentType: u.type,
    CacheControl: 'no-cache', // tiny site; always revalidate so deploys show up immediately
  }));
  console.log(`  uploaded ${u.key}`);
}

// Remove files that no longer exist locally.
const keep = new Set(uploads.map((u) => u.key));
const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
const stale = (listed.Contents || []).map((o) => o.Key).filter((k) => !keep.has(k));
if (stale.length) {
  await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: stale.map((Key) => ({ Key })) } }));
  console.log(`  removed ${stale.length} stale file(s)`);
}

console.log(`\nFrontend published: ${out.WebsiteUrl}`);
