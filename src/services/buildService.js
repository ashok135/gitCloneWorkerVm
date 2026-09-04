const path = require('path');
const fs = require('fs');
const express = require('express');
const { runCommand } = require('./commandRunner');
const { getNextAvailablePort } = require('./portService');
const { SANDBOXES_DIR, PUBLIC_HOST } = require('../config/env');
const eventBus = require('../events/eventBus');

// In-memory store for active deployments & running sandbox preview servers
const deployments = new Map();
const runningServers = new Map();

// Ensure sandboxes directory exists
if (!fs.existsSync(SANDBOXES_DIR)) {
  fs.mkdirSync(SANDBOXES_DIR, { recursive: true });
}

/**
 * Execute the 4-step deployment pipeline
 */
async function executeBuildPipeline(deployment) {
  const targetDir = path.join(SANDBOXES_DIR, deployment.id);

  try {
    // ----------------------------------------------------
    // STEP 1: CLONING REPOSITORY
    // ----------------------------------------------------
    deployment.step = 1;
    deployment.status = 'cloning';
    deployment.logs.push(`Cloning repository ${deployment.repoUrl}...`);
    eventBus.emit(`update:${deployment.id}`, deployment);

    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }

    await runCommand(`git clone --depth 1 "${deployment.repoUrl}" "${targetDir}"`, SANDBOXES_DIR, deployment);
    deployment.logs.push('✓ Repository cloned successfully.');
    eventBus.emit(`update:${deployment.id}`, deployment);

    // ----------------------------------------------------
    // STEP 2: INSTALLING DEPENDENCIES & BUILDING BUNDLE
    // ----------------------------------------------------
    deployment.step = 2;
    deployment.status = 'building';
    deployment.logs.push('Compiling sandbox bundle...');
    eventBus.emit(`update:${deployment.id}`, deployment);

    const packageJsonPath = path.join(targetDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      let pkg = {};
      try {
        pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      } catch (e) {}

      deployment.logs.push('Running npm install (memory-optimized)...');
      await runCommand('npm install --prefer-offline --no-audit --no-fund', targetDir, deployment);
      deployment.logs.push('✓ Dependencies installed.');

      if (pkg.scripts && pkg.scripts.build) {
        deployment.logs.push('Running build script: npm run build...');
        await runCommand('npm run build', targetDir, deployment);
        deployment.logs.push('✓ Build completed successfully.');
      } else {
        deployment.logs.push('No "build" script in package.json. Skipping compile.');
      }
    } else {
      deployment.logs.push('No package.json found. Serving static directory.');
    }
    eventBus.emit(`update:${deployment.id}`, deployment);

    // ----------------------------------------------------
    // STEP 3: SPAWN PREVIEW INSTANCE ON VM PORT
    // ----------------------------------------------------
    deployment.step = 3;
    deployment.status = 'starting';
    deployment.logs.push('Spawning sandbox preview server...');
    eventBus.emit(`update:${deployment.id}`, deployment);

    // Find the build output folder
    const candidateFolders = ['dist', 'build', 'out', 'public', '.'];
    let staticDir = targetDir;
    for (const folder of candidateFolders) {
      const fullPath = path.join(targetDir, folder);
      if (folder !== '.' && fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        staticDir = fullPath;
        break;
      }
    }

    const port = await getNextAvailablePort(4001);
    deployment.port = port;

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
        res.status(404).send('<h3>Mini Vercel: No index.html found in build output</h3>');
      }
    });

    const server = previewApp.listen(port, '0.0.0.0', () => {
      deployment.logs.push(`✓ Preview server listening on port ${port}`);
    });

    runningServers.set(deployment.id, server);

    let rawHost = (deployment.host || PUBLIC_HOST || 'localhost').trim();
    // Strip leading protocol (http:// or https://) and trailing slashes if passed in .env or headers
    let cleanHost = rawHost.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    // If the host included a port (e.g. 129.225.66.172:4000), strip it so we don't end up with host:4000:4001
    cleanHost = cleanHost.split(':')[0] || 'localhost';

    const liveUrl = `http://${cleanHost}:${port}`;
    deployment.url = liveUrl;

    // ----------------------------------------------------
    // STEP 4: LIVE!
    // ----------------------------------------------------
    deployment.step = 4;
    deployment.status = 'live';
    deployment.logs.push(`🎉 Deployment is LIVE at: ${liveUrl}`);
    eventBus.emit(`update:${deployment.id}`, deployment);

  } catch (err) {
    const failedStep = deployment.step || 1;
    deployment.step = -failedStep;
    deployment.status = 'failed';
    deployment.error = err.message || 'Build failed';
    deployment.logs.push(`❌ Error: ${deployment.error}`);
    eventBus.emit(`update:${deployment.id}`, deployment);
  }
}

/**
 * Register a new build job and start pipeline
 */
function createDeployment(id, repoName, repoUrl, host) {
  const deployment = {
    id,
    repoName,
    repoUrl,
    host,
    step: 1,
    status: 'cloning',
    logs: [`[${new Date().toLocaleTimeString()}] Worker accepted build for ${repoName}`],
    createdAt: new Date().toISOString(),
  };

  deployments.set(id, deployment);
  executeBuildPipeline(deployment);
  return deployment;
}

function getDeployment(id) {
  return deployments.get(id);
}

function getRunningCount() {
  return runningServers.size;
}

module.exports = {
  createDeployment,
  getDeployment,
  getRunningCount,
};
