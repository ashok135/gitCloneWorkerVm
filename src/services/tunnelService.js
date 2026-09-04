const { spawn } = require('child_process');

// Map of deploymentId -> { proc, url }
const activeTunnels = new Map();

/**
 * Spawns an isolated cloudflared quick tunnel for the given port.
 * Resolves with the unique https://xxx.trycloudflare.com URL as soon as Cloudflare provisions it.
 * Falls back cleanly (null) if cloudflared is unavailable or times out.
 */
function startTunnel(deploymentId, port) {
  return new Promise((resolve) => {
    // If a tunnel already exists for this deployment, terminate it first
    stopTunnel(deploymentId);

    try {
      console.log(`🚇 Spawning dedicated Cloudflare quick-tunnel for ${deploymentId} on port ${port}...`);

      const proc = spawn(
        'cloudflared',
        [
          'tunnel',
          '--url', `http://127.0.0.1:${port}`,
          '--metrics', '127.0.0.1:0',
          '--no-autoupdate',
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        }
      );

      activeTunnels.set(deploymentId, { proc, url: null });

      let resolved = false;
      let stderrBuffer = '';

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          console.warn(`⚠️ Cloudflare tunnel startup timed out for ${deploymentId} after 20s`);
          console.warn(`⚠️ cloudflared stderr so far:\n${stderrBuffer}`);
          resolve(null);
        }
      }, 20000);

      const inspectOutput = (chunk) => {
        const text = chunk.toString();
        stderrBuffer += text;
        // Match Cloudflare generated hostname: https://<random>.trycloudflare.com
        const match = text.match(/https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com/);
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          const tunnelUrl = match[0];
          // Update the stored tunnel info with the URL
          const entry = activeTunnels.get(deploymentId);
          if (entry) entry.url = tunnelUrl;
          console.log(`✓ Dedicated tunnel provisioned for ${deploymentId}: ${tunnelUrl}`);
          resolve(tunnelUrl);
        }
      };

      if (proc.stdout) proc.stdout.on('data', inspectOutput);
      if (proc.stderr) proc.stderr.on('data', inspectOutput);

      proc.on('error', (err) => {
        console.error(`❌ cloudflared spawn error for ${deploymentId}: ${err.message}`);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(null);
        }
      });

      proc.on('close', (code, signal) => {
        console.warn(`⚠️ cloudflared process for ${deploymentId} exited with code=${code} signal=${signal}`);
        if (stderrBuffer && !resolved) {
          console.warn(`⚠️ cloudflared last output:\n${stderrBuffer.slice(-500)}`);
        }
        activeTunnels.delete(deploymentId);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(null);
        }
      });
    } catch (err) {
      console.error(`Failed to create tunnel for ${deploymentId}:`, err.message);
      resolve(null);
    }
  });
}

/**
 * Immediately kills and cleans up the tunnel process for a deployment
 */
function stopTunnel(deploymentId) {
  if (activeTunnels.has(deploymentId)) {
    const entry = activeTunnels.get(deploymentId);
    const proc = entry ? entry.proc : null;
    try {
      console.log(`🛑 Terminating Cloudflare tunnel for deployment ${deploymentId}...`);
      if (proc && !proc.killed) {
        proc.kill('SIGTERM');
        setTimeout(() => {
          try {
            if (proc && !proc.killed) {
              proc.kill('SIGKILL');
            }
          } catch {}
        }, 1200);
      }
    } catch (e) {
      console.warn(`Error stopping tunnel for ${deploymentId}:`, e.message);
    }
    activeTunnels.delete(deploymentId);
    return true;
  }
  return false;
}

/**
 * Stop all active tunnels on shutdown/restart
 */
function stopAllTunnels() {
  for (const id of activeTunnels.keys()) {
    stopTunnel(id);
  }
}

/**
 * Check if a tunnel is still alive for a deployment
 */
function isTunnelAlive(deploymentId) {
  const entry = activeTunnels.get(deploymentId);
  return entry && entry.proc && !entry.proc.killed;
}

process.on('exit', stopAllTunnels);
process.on('SIGINT', () => {
  stopAllTunnels();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopAllTunnels();
  process.exit(0);
});

module.exports = {
  startTunnel,
  stopTunnel,
  stopAllTunnels,
  isTunnelAlive,
};
