import { onRequest } from '../functions/api/upload.js';

async function runTest() {
  console.log('Testing upload.js logic...');

  // Mock Env and Request for Single File Upload
  const mockEnv = {
    UPLOAD_KEY: 'testkey',
    PUBLIC_BASE: 'https://pub-test.r2.dev',
    BUCKET: {
      storage: new Map(),
      async head(key) {
        return this.storage.has(key) ? {} : null;
      },
      async put(key, body, opts) {
        this.storage.set(key, { body, opts });
      }
    }
  };

  // 1. Single File Upload Test
  const singleFileReq = new Request('https://localhost/api/upload', {
    method: 'POST',
    headers: {
      'x-hd-key': 'testkey',
      'x-hd-id': 'single12345',
      'x-hd-ttl': 'm',
      'x-hd-type': 'file',
    },
    body: new TextEncoder().encode('<h1>Hello Single File</h1>')
  });

  const res1 = await onRequest({ request: singleFileReq, env: mockEnv });
  const data1 = await res1.json();
  console.log('Single File Result:', data1);
  if (!data1.url.endsWith('/m/single12345')) throw new Error('Single file URL mismatch');

  // 2. Folder Upload Test
  const file1 = new TextEncoder().encode('<h1>Folder Home</h1>');
  const file2 = new TextEncoder().encode('body { background: red; }');
  const file3 = new TextEncoder().encode('console.log("hello folder");');

  const manifest = [
    { path: 'index.html', type: 'text/html; charset=utf-8', size: file1.byteLength },
    { path: 'css/style.css', type: 'text/css; charset=utf-8', size: file2.byteLength },
    { path: 'js/main.js', type: 'text/javascript; charset=utf-8', size: file3.byteLength }
  ];

  const manifestStr = JSON.stringify(manifest);
  const manifestBytes = new TextEncoder().encode(manifestStr);

  const totalSize = 4 + manifestBytes.byteLength + file1.byteLength + file2.byteLength + file3.byteLength;
  const rawPayload = new Uint8Array(totalSize);

  const dataView = new DataView(rawPayload.buffer);
  dataView.setUint32(0, manifestBytes.byteLength, false);

  rawPayload.set(manifestBytes, 4);

  let offset = 4 + manifestBytes.byteLength;
  rawPayload.set(file1, offset); offset += file1.byteLength;
  rawPayload.set(file2, offset); offset += file2.byteLength;
  rawPayload.set(file3, offset); offset += file3.byteLength;

  const folderReq = new Request('https://localhost/api/upload', {
    method: 'POST',
    headers: {
      'x-hd-key': 'testkey',
      'x-hd-id': 'folder12345',
      'x-hd-ttl': 'm',
      'x-hd-type': 'folder',
      'x-hd-entry': 'index.html',
    },
    body: rawPayload
  });

  const res2 = await onRequest({ request: folderReq, env: mockEnv });
  const data2 = await res2.json();
  console.log('Folder Upload Result:', data2);
  if (!data2.url.endsWith('/m/folder12345/index.html')) throw new Error('Folder URL mismatch');
  if (data2.fileCount !== 3) throw new Error('File count mismatch');

  console.log('Bucket Keys Stored:');
  for (const [k, v] of mockEnv.BUCKET.storage.entries()) {
    console.log(` - ${k} (${v.opts.httpMetadata.contentType}, enc: ${v.opts.httpMetadata.contentEncoding || 'none'})`);
  }

  // 3. Deduplication Test
  const folderReqDup = new Request('https://localhost/api/upload', {
    method: 'POST',
    headers: {
      'x-hd-key': 'testkey',
      'x-hd-id': 'folder12345',
      'x-hd-ttl': 'm',
      'x-hd-type': 'folder',
      'x-hd-entry': 'index.html',
    },
    body: rawPayload
  });

  const res3 = await onRequest({ request: folderReqDup, env: mockEnv });
  const data3 = await res3.json();
  console.log('Folder Deduplicated Upload Result:', data3);
  if (!data3.deduped) throw new Error('Expected deduped: true for duplicate upload');

  console.log('SUCCESS: All unit tests passed perfectly!');
}

runTest().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
