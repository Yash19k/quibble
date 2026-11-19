// Upload public/ to the S3 website bucket, plus a generated config.js that points the
// browser at this stack's API Gateway endpoints.
// Usage: npm run publish
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
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

// AWS SDK clients are root devDependencies: explain a missing one instead of crashing.
let s3sdk, stack;
try {
  s3sdk = await import('@aws-sdk/client-s3');
  stack = await import('./stack.mjs');
} catch (err) {
  console.error(`Missing a dependency (${err.message}). Run "npm install" in the project folder.`);
  process.exit(1);
}
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = s3sdk;

const out = await stack.stackOutputs();
const bucket = out.FrontendBucketName;
const s3 = new S3Client({});
const publicDir = path.join(stack.ROOT_DIR, 'public');

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
    ContentType: u.type, // the HTTPS endpoint serves exactly this type
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

// WebsiteUrl is the HTTPS link (S3's REST endpoint + /index.html). Browsers warn on the plain HTTP website endpoint.
console.log(`\nFrontend published. Share this link with players:\n  ${out.WebsiteUrl}`);
if (!out.WebsiteUrl?.startsWith('https://')) console.log('  (an older stack: run "npm run deploy" to get the HTTPS link)');
else if (out.WebsiteHttpUrl) console.log(`  (plain HTTP, not recommended: ${out.WebsiteHttpUrl})`);
