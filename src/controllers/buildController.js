const { createDeployment, getDeployment, getRunningCount, stopAndRemoveDeployment } = require('../services/buildService');
const eventBus = require('../events/eventBus');

/**
 * Trigger a new build on the worker
 * POST /build
 */
function triggerBuild(req, res) {
  const { deploymentId, repositoryUrl, repoName, envVars } = req.body;

  if (!repositoryUrl) {
    return res.status(400).json({ error: 'repositoryUrl is required' });
  }

  const id = deploymentId || `dep_${Date.now()}`;
  const name = repoName || 'my-project';

  const { PUBLIC_HOST } = require('../config/env');
  const cleanPublicHost = PUBLIC_HOST
    ? PUBLIC_HOST.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').split(':')[0]
    : null;
  const hostFromReq = req.get('host')
    ? req.get('host').trim().replace(/^https?:\/\//i, '').split(':')[0]
    : null;
  const host = (cleanPublicHost && cleanPublicHost !== 'localhost')
    ? cleanPublicHost
    : (hostFromReq || 'localhost');

  createDeployment(id, name, repositoryUrl, host, envVars);

  res.status(202).json({
    message: 'Build accepted by worker',
    deploymentId: id,
    status: 'cloning',
  });
}

/**
 * Poll current build status & logs
 * GET /status/:id
 */
function getBuildStatus(req, res) {
  const deployment = getDeployment(req.params.id);
  if (!deployment) {
    return res.status(404).json({ error: 'Deployment not found' });
  }
  res.json(deployment);
}

/**
 * Stream real-time build progress via Server-Sent Events (SSE)
 * GET /stream/:id
 */
function streamBuildProgress(req, res) {
  const deployment = getDeployment(req.params.id);
  if (!deployment) {
    return res.status(404).json({ error: 'Deployment not found' });
  }

  // Set SSE Headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // 1. Send current state immediately
  res.write(`data: ${JSON.stringify(deployment)}\n\n`);

  // 2. Subscribe to real-time events for this deployment
  const onUpdate = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (data.step === 4 || data.step === -1 || data.step === -99) {
      res.end();
    }
  };

  eventBus.on(`update:${deployment.id}`, onUpdate);

  // 3. Clean up on connection close
  req.on('close', () => {
    eventBus.off(`update:${deployment.id}`, onUpdate);
  });
}

/**
 * Stop running server and remove sandbox directory (Option 3)
 * DELETE /sandbox/:id
 */
async function stopSandbox(req, res) {
  const { id } = req.params;
  const stopped = await stopAndRemoveDeployment(id, 'user-request');
  if (!stopped) {
    return res.status(404).json({ error: 'Sandbox not found or already stopped' });
  }
  res.json({ message: `Sandbox ${id} stopped and cleaned from disk`, status: 'stopped' });
}

/**
 * Worker health check
 * GET /health
 */
function getHealth(req, res) {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    activeSandboxes: getRunningCount(),
  });
}

module.exports = {
  triggerBuild,
  getBuildStatus,
  streamBuildProgress,
  stopSandbox,
  getHealth,
};
