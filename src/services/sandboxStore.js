/**
 * In-memory store for active deployments, running preview servers, and TTL timers
 */
const deployments = new Map();
const runningServers = new Map();
const sandboxTimers = new Map();

function saveDeployment(id, data) {
  deployments.set(id, data);
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
  return deployments.delete(id);
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
