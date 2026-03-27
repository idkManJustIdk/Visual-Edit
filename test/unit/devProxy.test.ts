import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DevProxy } from '../../src/devProxy';

// ── Helpers ───────────────────────────────────────────────────────────────────

const LOCALHOST_IP = '127.0.0.1';

/** Spin up a tiny HTTP server that always returns the given body + content-type. */
function fakeServer(body: string, contentType: string): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': contentType });
      res.end(body);
    });
    server.listen(0, LOCALHOST_IP, () => {
      resolve({ server, port: (server.address() as any).port });
    });
  });
}

/** Fire a GET request through the proxy and return the body as a string. */
function getThrough(proxyPort: number, path = '/'): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(`http://${LOCALHOST_IP}:${proxyPort}${path}`, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

/** Fire a GET request and return the full response (status + body). */
function getResponse(proxyPort: number, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://${LOCALHOST_IP}:${proxyPort}${path}`, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DevProxy', () => {
  const proxies: DevProxy[] = [];
  const servers: http.Server[] = [];

  afterEach(async () => {
    for (const p of proxies) { p.dispose(); }
    proxies.length = 0;
    await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r()))));
    servers.length = 0;
  });

  it('starts on a valid port', async () => {
    const proxy = await DevProxy.create();
    proxies.push(proxy);
    expect(proxy.port).toBeGreaterThan(0);
    expect(proxy.port).toBeLessThanOrEqual(65535);
  });

  it('injects DEVTOOLS_SCRIPT into HTML responses', async () => {
    const { server, port } = await fakeServer('<html><head></head><body>hi</body></html>', 'text/html');
    servers.push(server);

    const proxy = await DevProxy.create();
    proxies.push(proxy);
    proxy.setTarget(`http://${LOCALHOST_IP}:${port}`);

    const body = await getThrough(proxy.port);
    expect(body).toContain('__bt_console');          // part of DEVTOOLS_SCRIPT
    expect(body).toContain('data-bt-devtools="1"');  // INJECT_TAG marker
    expect(body).toContain('hi');                    // original content preserved
  });

  it('injects at top of page when </head> is absent', async () => {
    const { server, port } = await fakeServer('<body>no head</body>', 'text/html');
    servers.push(server);

    const proxy = await DevProxy.create();
    proxies.push(proxy);
    proxy.setTarget(`http://${LOCALHOST_IP}:${port}`);

    const body = await getThrough(proxy.port);
    expect(body).toContain('data-bt-devtools="1"');
    expect(body).toContain('no head');
  });

  it('passes through non-HTML responses unchanged', async () => {
    const jsonBody = '{"ok":true}';
    const { server, port } = await fakeServer(jsonBody, 'application/json');
    servers.push(server);

    const proxy = await DevProxy.create();
    proxies.push(proxy);
    proxy.setTarget(`http://${LOCALHOST_IP}:${port}`);

    const body = await getThrough(proxy.port);
    expect(body).toBe(jsonBody);
    expect(body).not.toContain('data-bt-devtools');
  });

  it('returns 502 when the upstream is unreachable', async () => {
    const proxy = await DevProxy.create();
    proxies.push(proxy);
    // Point at a port nothing is listening on
    proxy.setTarget(`http://${LOCALHOST_IP}:1`);

    const { status } = await getResponse(proxy.port);
    expect(status).toBe(502);
  });

  it('setTarget() switches the upstream mid-session', async () => {
    const { server: s1, port: p1 } = await fakeServer('<html><head></head>server1</html>', 'text/html');
    const { server: s2, port: p2 } = await fakeServer('<html><head></head>server2</html>', 'text/html');
    servers.push(s1, s2);

    const proxy = await DevProxy.create();
    proxies.push(proxy);

    proxy.setTarget(`http://${LOCALHOST_IP}:${p1}`);
    const body1 = await getThrough(proxy.port);
    expect(body1).toContain('server1');

    proxy.setTarget(`http://${LOCALHOST_IP}:${p2}`);
    const body2 = await getThrough(proxy.port);
    expect(body2).toContain('server2');
  });

  describe('File Serving Mode', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-test-'));
      fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><head></head><body>local</body></html>');
      fs.writeFileSync(path.join(tmpDir, 'style.css'), 'body { color: red; }');
      fs.mkdirSync(path.join(tmpDir, 'sub'));
      fs.writeFileSync(path.join(tmpDir, 'sub', 'page.html'), '<html><head></head><body>sub</body></html>');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('serves a local HTML file and injects devtools', async () => {
      const proxy = await DevProxy.create();
      proxies.push(proxy);

      let mapped = path.join(tmpDir, 'index.html').replace(/\\/g, '/');
      if (!mapped.startsWith('/')) { mapped = '/' + mapped; }
      proxy.setTarget(`file://${mapped}`);

      const encodedPath = mapped.split('/').map(encodeURIComponent).join('/');
      const body = await getResponse(proxy.port, encodedPath);

      expect(body.status).toBe(200);
      expect(body.body).toContain('data-bt-devtools="1"');
      expect(body.body).toContain('local');
    });

    it('serves relative assets from the same directory', async () => {
      const proxy = await DevProxy.create();
      proxies.push(proxy);

      let mapped = path.join(tmpDir, 'index.html').replace(/\\/g, '/');
      if (!mapped.startsWith('/')) { mapped = '/' + mapped; }
      proxy.setTarget(`file://${mapped}`);

      const res = await getResponse(proxy.port, '/style.css');
      expect(res.status).toBe(200);
      expect(res.body).toBe('body { color: red; }');

      const resSub = await getResponse(proxy.port, '/sub/page.html');
      expect(resSub.status).toBe(200);
      expect(resSub.body).toContain('sub');
      expect(resSub.body).toContain('data-bt-devtools="1"');
    });

    it('returns 404 for missing files', async () => {
      const proxy = await DevProxy.create();
      proxies.push(proxy);

      let mapped = path.join(tmpDir, 'index.html').replace(/\\/g, '/');
      if (!mapped.startsWith('/')) { mapped = '/' + mapped; }
      proxy.setTarget(`file://${mapped}`);

      const { status } = await getResponse(proxy.port, '/missing.css');
      expect(status).toBe(404);
    });
  });
});
