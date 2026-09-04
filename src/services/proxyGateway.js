const http = require('http');
const { getAllDeployments } = require('./sandboxStore');

const WORKER_RESERVED_ROUTES = [
  '/build',
  '/deploy-files',
  '/sandboxes',
  '/status',
  '/stream',
  '/sandbox',
  '/stop',
  '/health',
];

/**
 * Parses cookies from cookie header
 */
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    list[parts.shift().trim()] = decodeURI(parts.join('='));
  });
  return list;
}

/**
 * Resolves which internal sandbox port to target
 */
function resolveTarget(req) {
  const urlPath = req.path || req.url || '/';

  // Check if reserved worker API endpoint
  for (const reserved of WORKER_RESERVED_ROUTES) {
    if (urlPath === reserved || urlPath.startsWith(reserved + '/')) {
      return null;
    }
  }

  // 1. Path prefix: /p/4001 or /p/4001/index.html
  const pathMatch = req.url.match(/^\/p\/(\d+)(\/.*)?$/);
  if (pathMatch) {
    return {
      port: parseInt(pathMatch[1], 10),
      url: pathMatch[2] || '/',
    };
  }

  // 2. Query param ?_port=4001 or ?port=4001
  try {
    const urlObj = new URL(req.url, 'http://localhost');
    const queryPort = urlObj.searchParams.get('_port') || urlObj.searchParams.get('port');
    if (queryPort) {
      return {
        port: parseInt(queryPort, 10),
        url: req.url,
      };
    }
  } catch (e) {}

  // 3. Custom Header: x-sandbox-port
  const headerPort = req.headers['x-sandbox-port'];
  if (headerPort) {
    return {
      port: parseInt(headerPort, 10),
      url: req.url,
    };
  }

  // 4. Cookie: sandbox_port
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.sandbox_port) {
    const port = parseInt(cookies.sandbox_port, 10);
    if (!isNaN(port) && port >= 4001) {
      return {
        port,
        url: req.url,
      };
    }
  }

  // No explicit routing found — let the request fall through to the worker API
  return null;
}

/**
 * Reverse-proxies an HTTP request to the target sandbox port
 */
function proxyToSandbox(targetPort, targetUrl, req, res) {
  const options = {
    hostname: '127.0.0.1',
    port: targetPort,
    path: targetUrl,
    method: req.method,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${targetPort}`,
      'x-forwarded-host': req.headers.host,
      'x-forwarded-proto': 'https',
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const headers = { ...proxyRes.headers };
    // Remove frame restrictions so live viewport iframe works cleanly
    delete headers['x-frame-options'];
    headers['content-security-policy'] = 'frame-ancestors *';
    headers['access-control-allow-origin'] = '*';

    // Set cookie so future asset calls from this tab stay on this sandbox port
    headers['set-cookie'] = `sandbox_port=${targetPort}; Path=/; SameSite=Lax`;

    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).send(
        `<div style="font-family:sans-serif;padding:32px;background:#111;color:#eee;min-height:100vh;">
          <h2 style="color:#ef4444;">⚠️ Mini-Vercel: Sandbox Offline</h2>
          <p>The sandbox process on port <strong>${targetPort}</strong> is not running or has not finished starting yet.</p>
          <pre style="background:#222;padding:12px;border-radius:6px;color:#aaa;">${err.message}</pre>
        </div>`
      );
    }
  });

  req.pipe(proxyReq, { end: true });
}

/**
 * Express middleware
 */
function reverseProxyMiddleware(req, res, next) {
  const target = resolveTarget(req);
  if (target) {
    return proxyToSandbox(target.port, target.url, req, res);
  }
  next();
}

module.exports = {
  reverseProxyMiddleware,
  resolveTarget,
};
