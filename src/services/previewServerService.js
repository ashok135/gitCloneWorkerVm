const fs = require('fs');
const path = require('path');
const express = require('express');
const { getNextAvailablePort } = require('./portService');
const { registerServer, setTtlTimer } = require('./sandboxStore');
const { PUBLIC_HOST, SANDBOX_TTL_MINUTES } = require('../config/env');

const CANDIDATE_STATIC_FOLDERS = ['dist', 'build', 'out', 'public', '.'];

/**
 * Finds static build output folder and spawns isolated Express preview server
 */
async function launchPreviewServer(targetDir, deployment, onExpire, emitUpdate) {
  // 1. Locate static output directory
  let staticDir = targetDir;
  for (const folder of CANDIDATE_STATIC_FOLDERS) {
    const fullPath = path.join(targetDir, folder);
    if (folder !== '.' && fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      staticDir = fullPath;
      break;
    }
  }

  // 2. OPTION 1: Clean up node_modules to reclaim ~300-500MB disk space per sandbox
  const nmPath = path.join(targetDir, 'node_modules');
  if (fs.existsSync(nmPath)) {
    fs.rm(nmPath, { recursive: true, force: true }, (rmErr) => {
      if (!rmErr) {
        deployment.logs.push('🧹 Option 1: Cleaned up node_modules to preserve VM disk space.');
        emitUpdate();
      }
    });
  }

  // 3. Allocate isolated port
  const port = await getNextAvailablePort(4001);
  deployment.port = port;

  // 4. Create preview application
  const previewApp = express();
  previewApp.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  });
  previewApp.use(express.static(staticDir));
  previewApp.get('*', (req, res) => {
    const indexHtml = path.join(staticDir, 'index.html');
    if (fs.existsSync(indexHtml)) {
      res.sendFile(indexHtml);
    } else {
      try {
        const files = fs.readdirSync(staticDir);
        const htmlFile = files.find((f) => f.toLowerCase().endsWith('.html'));
        if (htmlFile) {
          return res.sendFile(path.join(staticDir, htmlFile));
        }
      } catch (e) {}
      res.status(404).send('<h3>Mini Vercel: No HTML files found in preview output</h3>');
    }
  });

  const server = previewApp.listen(port, '0.0.0.0', () => {
    deployment.logs.push(`✓ Preview server listening on port ${port}`);
  });

  registerServer(deployment.id, server);

  // 5. Compute public URL
  const rawHost = (deployment.host || PUBLIC_HOST || 'localhost').trim();
  const cleanHost = rawHost
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .split(':')[0] || 'localhost';

  const liveUrl = `http://${cleanHost}:${port}`;
  deployment.url = liveUrl;

  // 6. OPTION 2: Auto-expire TTL timer
  const ttlMinutes = SANDBOX_TTL_MINUTES || 60;
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
  deployment.expiresAt = expiresAt;
  deployment.ttlMinutes = ttlMinutes;

  const timer = setTimeout(async () => {
    console.log(`⏳ Auto-expiring sandbox ${deployment.id} after ${ttlMinutes}m`);
    await onExpire(deployment.id, 'auto-expired');
  }, ttlMinutes * 60 * 1000);

  setTtlTimer(deployment.id, timer);

  // 7. Complete step
  deployment.step = 4;
  deployment.status = 'live';
  deployment.logs.push(`🎉 Deployment is LIVE at: ${liveUrl}`);
  deployment.logs.push(`⏳ Option 2: Auto-teardown scheduled in ${ttlMinutes} mins to free resources.`);
  emitUpdate();

  return liveUrl;
}

module.exports = {
  launchPreviewServer,
};
