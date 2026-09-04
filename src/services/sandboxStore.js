const fs = require('fs');
const path = require('path');
const { SANDBOXES_DIR } = require('../config/env');

const REGISTRY_FILE = path.join(SANDBOXES_DIR, 'deployments_registry.json');

/**
 * In-memory store for active deployments, running preview servers, and TTL timers
 * with persistent JSON disk backup
 */
const deployments = new Map();
const runningServers = new Map();
const runningProcesses = new Map();
const sandboxTimers = new Map();

// 1. Ensure sandboxes directory exists
if (!fs.existsSync(SANDBOXES_DIR)) {
  fs.mkdirSync(SANDBOXES_DIR, { recursive: true });
}

// 2. Load persisted deployments from disk on startup
try {
  if (fs.existsSync(REGISTRY_FILE)) {
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const now = Date.now();
      parsed.forEach((d) => {
        if (d && d.id) {
          const isExpired = d.expiresAt && new Date(d.expiresAt).getTime() < now;
          // Only restore active, non-expired deployments with allocated port
          if (!isExpired && d.status === 'live' && d.port) {
            deployments.set(d.id, d);
          }
        }
      });
      console.log(`✓ Restored ${deployments.size} active deployment(s) from disk registry.`);
    }
  }
} catch (e) {
  console.warn('Could not load deployments registry:', e.message);
}

// 3. Clean up orphaned or dead directories from previous crashes/restarts
try {
  const entries = fs.readdirSync(SANDBOXES_DIR);
  for (const entry of entries) {
    if (entry.startsWith('dep_')) {
      const full = path.join(SANDBOXES_DIR, entry);
      // If folder is not currently a valid restored deployment, remove it to save disk space
      if (!deployments.has(entry) && fs.statSync(full).isDirectory()) {
        try {
          fs.rmSync(full, { recursive: true, force: true });
          console.log(`🧹 Cleaned up stale orphaned sandbox directory: ${entry}`);
        } catch (rmErr) {
          console.warn(`Could not delete stale directory ${entry}:`, rmErr.message);
        }
      }
    }
  }
} catch (e) {}

function persistToDisk() {
  try {
    const data = Array.from(deployments.values()).map((d) => ({
      id: d.id,
      repoName: d.repoName,
      repoUrl: d.repoUrl,
      isUpload: Boolean(d.isUpload),
      status: d.status,
      step: d.step,
      port: d.port,
      url: d.url,
      rootDir: d.rootDir || '',
      isBackend: Boolean(d.isBackend),
      projectType: d.projectType || 'auto',
      createdAt: d.createdAt,
      expiresAt: d.expiresAt,
      ttlMinutes: d.ttlMinutes,
      detectedEnv: d.detectedEnv,
    }));
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write deployments registry:', e.message);
  }
}

function saveDeployment(id, data) {
  deployments.set(id, data);
  persistToDisk();
  return data;
}

function getDeployment(id) {
  return deployments.get(id);
}

function getAllDeployments() {
  const now = Date.now();
  return Array.from(deployments.values())
    .filter((d) => {
      if (!d || !d.id) return false;
      if (d.expiresAt && new Date(d.expiresAt).getTime() < now) return false;
      if (d.status === 'live' && !d.port && !d.url) return false;
      return d.status !== 'stopped' && d.status !== 'expired';
    })
    .map((d) => ({
      id: d.id,
      repoName: d.repoName,
      repoUrl: d.repoUrl,
      isUpload: Boolean(d.isUpload),
      status: d.status,
      step: d.step,
      port: d.port,
      url: d.url,
      rootDir: d.rootDir || '',
      isBackend: Boolean(d.isBackend),
      projectType: d.projectType || 'auto',
      createdAt: d.createdAt,
      expiresAt: d.expiresAt,
      ttlMinutes: d.ttlMinutes,
      detectedEnv: d.detectedEnv,
    }))
    .reverse();
}

function deleteDeployment(id) {
  const res = deployments.delete(id);
  persistToDisk();
  return res;
}

function registerServer(id, server) {
  runningServers.set(id, server);
}

function getServer(id) {
  return runningServers.get(id);
}

function closeServer(id) {
  if (runningServers.has(id)) {
    const server = runningServers.get(id);
    try {
      server.close();
    } catch (e) {
      console.error(`Error closing preview server for ${id}:`, e);
    }
    runningServers.delete(id);
    return true;
  }
  return false;
}

function registerProcess(id, proc) {
  runningProcesses.set(id, proc);
}

function getProcess(id) {
  return runningProcesses.get(id);
}

function closeProcess(id) {
  if (runningProcesses.has(id)) {
    const proc = runningProcesses.get(id);
    try {
      if (proc && !proc.killed) {
        proc.kill('SIGTERM');
        setTimeout(() => {
          try {
            if (proc && !proc.killed) proc.kill('SIGKILL');
          } catch {}
        }, 1200);
      }
    } catch (e) {
      console.error(`Error closing child process for ${id}:`, e);
    }
    runningProcesses.delete(id);
    return true;
  }
  return false;
}

function setTtlTimer(id, timer) {
  clearTtlTimer(id);
  sandboxTimers.set(id, timer);
}

function clearTtlTimer(id) {
  if (sandboxTimers.has(id)) {
    clearTimeout(sandboxTimers.get(id));
    sandboxTimers.delete(id);
    return true;
  }
  return false;
}

function getRunningCount() {
  return runningServers.size + runningProcesses.size;
}

module.exports = {
  saveDeployment,
  getDeployment,
  getAllDeployments,
  deleteDeployment,
  registerServer,
  getServer,
  closeServer,
  registerProcess,
  getProcess,
  closeProcess,
  setTtlTimer,
  clearTtlTimer,
  getRunningCount,
};
