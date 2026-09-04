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
      parsed.forEach((d) => {
        if (d && d.id) {
          deployments.set(d.id, d);
        }
      });
      console.log(`✓ Restored ${deployments.size} deployment(s) from disk registry.`);
    }
  }
} catch (e) {
  console.warn('Could not load deployments registry:', e.message);
}

function inferRepoNameFromDisk(targetDir, fallbackId) {
  try {
    const pkgPath = path.join(targetDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.name && typeof pkg.name === 'string' && pkg.name.trim()) {
        return pkg.name.trim();
      }
    }

    const gitConfigPath = path.join(targetDir, '.git', 'config');
    if (fs.existsSync(gitConfigPath)) {
      const gitConfig = fs.readFileSync(gitConfigPath, 'utf8');
      const match = gitConfig.match(/url\s*=\s*.*\/([^\/\s]+?)(\.git)?$/m);
      if (match && match[1]) {
        return match[1].replace(/\.git$/i, '');
      }
    }

    const files = fs.readdirSync(targetDir);
    const htmlFile = files.find((f) => f.toLowerCase().endsWith('.html'));
    if (htmlFile) {
      if (htmlFile.toLowerCase() !== 'index.html') {
        return htmlFile.replace(/\.[^/.]+$/, '');
      }
      const htmlContent = fs.readFileSync(path.join(targetDir, htmlFile), 'utf8');
      const titleMatch = htmlContent.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch && titleMatch[1]?.trim()) {
        return titleMatch[1].trim();
      }
    }
  } catch (e) {}

  const shortSuffix = fallbackId.replace(/^dep_/, '').slice(-4);
  return `Project-${shortSuffix || 'sandbox'}`;
}

// 3. Scan for existing sandbox directories on disk
try {
  const entries = fs.readdirSync(SANDBOXES_DIR);
  for (const entry of entries) {
    if (entry.startsWith('dep_') && !deployments.has(entry)) {
      const full = path.join(SANDBOXES_DIR, entry);
      if (fs.statSync(full).isDirectory()) {
        const repoName = inferRepoNameFromDisk(full, entry);
        deployments.set(entry, {
          id: entry,
          repoName,
          status: 'live',
          step: 4,
          createdAt: fs.statSync(full).birthtime?.toISOString() || new Date().toISOString(),
        });
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
  return Array.from(deployments.values())
    .map((d) => ({
      id: d.id,
      repoName: d.repoName,
      repoUrl: d.repoUrl,
      isUpload: Boolean(d.isUpload),
      status: d.status,
      step: d.step,
      port: d.port,
      url: d.url,
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
  return runningServers.size;
}

module.exports = {
  saveDeployment,
  getDeployment,
  getAllDeployments,
  deleteDeployment,
  registerServer,
  getServer,
  closeServer,
  setTtlTimer,
  clearTtlTimer,
  getRunningCount,
};
