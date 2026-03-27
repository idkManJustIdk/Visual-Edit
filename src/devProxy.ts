import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as mime from 'mime-types';
import { INJECT_TAG } from './utils/devtools';

export class DevProxy {
  private readonly _server: http.Server;
  public readonly port: number;
  private _targetIsFile = false;
  private _baseDirectory = '';
  private _targetHost = 'localhost';
  private _targetPort = 3000;

  private constructor(port: number) {
    this.port = port;
    this._server = this._buildServer();
  }

  /** Factory: finds a free port, starts the proxy, returns the instance. */
  static async create(): Promise<DevProxy> {
    const port = await DevProxy._freePort();
    const proxy = new DevProxy(port);
    await new Promise<void>((res, rej) => {
      proxy._server.listen(port, '127.0.0.1', res);
      proxy._server.once('error', rej);
    });
    return proxy;
  }

  /** Switch the proxy target to a different localhost dev server or local file. */
  setTarget(targetUrl: string) {
    if (targetUrl.startsWith('file://')) {
      this._targetIsFile = true;
      try {
        const u = new URL(targetUrl);
        let p = decodeURIComponent(u.pathname);
        if (process.platform === 'win32' && p.startsWith('/') && p.length > 2 && p[2] === ':') {
          p = p.substring(1);
        }
        this._baseDirectory = path.dirname(p);
      } catch { }
      return;
    }

    this._targetIsFile = false;
    try {
      const u = new URL(targetUrl);
      this._targetHost = u.hostname;
      this._targetPort = parseInt(u.port || '80', 10);
    } catch { /* keep previous target */ }
  }

  dispose() { this._server.close(); }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private _buildServer(): http.Server {
    const server = http.createServer((req, res) => {
      // Strip internal _bt_r nonce and accept-encoding before forwarding
      let reqPath = req.url || '/';
      if (reqPath.includes('_bt_r=')) {
        try {
          const u = new URL('http://x' + reqPath);
          u.searchParams.delete('_bt_r');
          reqPath = u.pathname + u.search;
        } catch { }
      }

      if (this._targetIsFile) {
        let p = decodeURIComponent(reqPath.split('?')[0]);
        let fullPath = p;
        if (process.platform === 'win32' && p.startsWith('/') && p[2] === ':') {
          fullPath = p.substring(1);
        }

        if (!path.isAbsolute(fullPath) || !fs.existsSync(fullPath)) {
          fullPath = path.join(this._baseDirectory, p);
        }

        if (!fs.existsSync(fullPath)) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }

        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          fullPath = path.join(fullPath, 'index.html');
          if (!fs.existsSync(fullPath)) {
            res.writeHead(403);
            res.end('Directory listing forbidden');
            return;
          }
        }

        const contentType = mime.lookup(fullPath) || 'application/octet-stream';
        if (contentType === 'text/html') {
          let body = fs.readFileSync(fullPath, 'utf8');
          body = body.includes('</head>')
            ? body.replace('</head>', INJECT_TAG + '</head>')
            : INJECT_TAG + body;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(body);
        } else {
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': fs.statSync(fullPath).size
          });
          fs.createReadStream(fullPath).pipe(res);
        }
        return;
      }

      const headers = { ...req.headers, host: `${this._targetHost}:${this._targetPort}` };
      delete headers['accept-encoding'];

      const opts: http.RequestOptions = {
        host: this._targetHost,
        port: this._targetPort,
        path: reqPath,
        method: req.method || 'GET',
        headers,
      };

      const proxyReq = http.request(opts, (proxyRes) => {
        const ct = proxyRes.headers['content-type'] || '';
        if (ct.includes('text/html')) {
          // Collect body, inject script, forward modified HTML
          const chunks: Buffer[] = [];
          proxyRes.on('data', (c: Buffer) => chunks.push(c));
          proxyRes.on('end', () => {
            let body = Buffer.concat(chunks).toString('utf8');
            body = body.includes('</head>')
              ? body.replace('</head>', INJECT_TAG + '</head>')
              : INJECT_TAG + body;

            const outHeaders = { ...proxyRes.headers };
            delete outHeaders['content-length'];
            delete outHeaders['content-encoding'];
            outHeaders['content-type'] = 'text/html; charset=utf-8';

            res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
            res.end(body);
          });
        } else {
          res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
          proxyRes.pipe(res);
        }
      });

      proxyReq.on('error', (e) => {
        if (!res.headersSent) { res.writeHead(502); }
        res.end(`Proxy error: ${e.message}`);
      });
      req.pipe(proxyReq);
    });

    // WebSocket proxy — required for HMR (Vite, webpack, etc.)
    server.on('upgrade', (req, socket, _head) => {
      if (this._targetIsFile) {
        socket.destroy();
        return;
      }
      const opts: http.RequestOptions = {
        host: this._targetHost,
        port: this._targetPort,
        path: req.url || '/',
        headers: req.headers,
      };
      const proxyReq = http.request(opts);
      proxyReq.on('upgrade', (_res, proxySocket) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n');
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
        proxySocket.on('error', () => socket.destroy());
        socket.on('error', () => proxySocket.destroy());
      });
      proxyReq.on('error', () => socket.destroy());
      proxyReq.end();
    });

    return server;
  }

  private static _freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const port = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(port));
      });
      s.on('error', reject);
    });
  }
}
