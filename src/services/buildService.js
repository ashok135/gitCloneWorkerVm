const path = require('path');
const fs = require('fs');
const express = require('express');
const { runCommand } = require('./commandRunner');
const { getNextAvailablePort } = require('./portService');
const { SANDBOXES_DIR, PUBLIC_HOST, SANDBOX_TTL_MINUTES } = require('../config/env');
const eventBus = require('../events/eventBus');

// In-memory store for active deployments & running sandbox preview servers
const deployments = new Map();
const runningServers = new Map();
const sandboxTimers = new Map();

// Ensure sandboxes directory exists
if (!fs.existsSync(SANDBOXES_DIR)) {
  fs.mkdirSync(SANDBOXES_DIR, { recursive: true });
}

/**
 * Stop running server and remove sandbox directory from disk (Option 3 & Option 2)
 */
async function stopAndRemoveDeployment(id, reason = 'manual') {
  const deployment = deployments.get(id);
  if (!deployment) return false;

  // 1. Clear TTL timer
  if (sandboxTimers.has(id)) {
    clearTimeout(sandboxTimers.get(id));
    sandboxTimers.delete(id);
  }

  // 2. Stop running Express preview server
  if (runningServers.has(id)) {
    const server = runningServers.get(id);
    try {
      server.close();
      console.log(`🛑 Closed preview server for ${id} on port ${deployment.port}`);
    } catch (err) {
      console.error(`Error closing server for ${id}:`, err);
    }
    runningServers.delete(id);
  }

  // 3. Delete the sandbox directory from VM disk
  const targetDir = path.join(SANDBOXES_DIR, id);
  if (fs.existsSync(targetDir)) {
    try {
      await fs.promises.rm(targetDir, { recursive: true, force: true });
      console.log(`🗑️ Deleted sandbox directory ${targetDir}`);
    } catch (err) {
      console.error(`Error deleting sandbox directory ${targetDir}:`, err);
    }
  }

  // 4. Update deployment state & emit event
  deployment.status = reason === 'auto-expired' ? 'expired' : 'stopped';
  deployment.step = -99;
  deployment.url = null;
  deployment.logs.push(`🛑 Sandbox terminated (${reason}) and disk cleaned.`);
  eventBus.emit(`update:${id}`, deployment);

  return true;
}

/**
 * Execute the 4-step deployment pipeline
 */
async function executeBuildPipeline(deployment) {
  const targetDir = path.join(SANDBOXES_DIR, deployment.id);

  try {
    // ----------------------------------------------------
    // STEP 1: CLONING REPOSITORY / UNPACKING FILES
    // ----------------------------------------------------
    deployment.step = 1;
    if (deployment.isUpload) {
      deployment.status = 'unpacking';
      deployment.logs.push(`Unpacking ${deployment.files?.length || 0} uploaded project files into sandbox...`);
      eventBus.emit(`update:${deployment.id}`, deployment);

      if (fs.existsSync(targetDir)) {
        await fs.promises.rm(targetDir, { recursive: true, force: true });
      }
      fs.mkdirSync(targetDir, { recursive: true });

      if (Array.isArray(deployment.files)) {
        for (const file of deployment.files) {
          if (!file || !file.path) continue;
          // Protect against directory traversal
          const safePath = path.normalize(file.path).replace(/^(\.\.[\/\\])+/, '');
          const fullFilePath = path.join(targetDir, safePath);
          const dirName = path.dirname(fullFilePath);
          if (!fs.existsSync(dirName)) {
            fs.mkdirSync(dirName, { recursive: true });
          }
          if (file.encoding === 'base64') {
            fs.writeFileSync(fullFilePath, Buffer.from(file.content, 'base64'));
          } else {
            fs.writeFileSync(fullFilePath, file.content || '', 'utf8');
          }
        }
      }
      // Reclaim memory after writing to disk
      delete deployment.files;
      deployment.logs.push('✓ Files unpacked successfully into sandbox.');
      eventBus.emit(`update:${deployment.id}`, deployment);
    } else {
      deployment.status = 'cloning';
      deployment.logs.push(`Cloning repository ${deployment.repoUrl}...`);
      eventBus.emit(`update:${deployment.id}`, deployment);

      if (fs.existsSync(targetDir)) {
        await fs.promises.rm(targetDir, { recursive: true, force: true });
      }

      await runCommand(
        `git clone --depth 1 "${deployment.repoUrl}" "${targetDir}"`,
        SANDBOXES_DIR,
        (log) => {
          deployment.logs.push(log);
          eventBus.emit(`update:${deployment.id}`, deployment);
        }
      );

      deployment.logs.push('✓ Repository cloned successfully.');
      eventBus.emit(`update:${deployment.id}`, deployment);
    }

    // ----------------------------------------------------
    // ENVIRONMENT SETUP & DETECTION (.env, .env.example)
    // ----------------------------------------------------
    const envCandidateFiles = ['.env.example', '.env.sample', '.env.template', '.env.local.example'];
    let detectedEnvFile = null;
    for (const envFile of envCandidateFiles) {
      const fullEnvPath = path.join(targetDir, envFile);
      if (fs.existsSync(fullEnvPath)) {
        detectedEnvFile = fullEnvPath;
        break;
      }
    }

    if (detectedEnvFile) {
      try {
        const envContent = fs.readFileSync(detectedEnvFile, 'utf8');
        const envLines = envContent
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#') && l.includes('='));
        const detectedKeys = envLines.map((l) => l.split('=')[0].trim());
        deployment.detectedEnv = {
          file: path.basename(detectedEnvFile),
          keys: detectedKeys,
          template: envContent,
        };
        deployment.logs.push(
          `ℹ Environment setup: detected ${path.basename(detectedEnvFile)} with ${detectedKeys.length} variable(s): [${detectedKeys.join(', ')}]`
        );
        eventBus.emit(`update:${deployment.id}`, deployment);
      } catch (e) {}
    }

    // Write custom env variables if provided by user
    if (deployment.envVars) {
      try {
        let envContent = '';
        if (typeof deployment.envVars === 'string') {
          envContent = deployment.envVars;
        } else if (typeof deployment.envVars === 'object') {
          envContent = Object.entries(deployment.envVars)
            .map(([k, v]) => `${k}=${v}`)
            .join('\n');
        }
        if (envContent.trim()) {
          fs.writeFileSync(path.join(targetDir, '.env'), envContent, 'utf8');
          deployment.logs.push('✓ Applied user-configured environment variables (.env).');
          eventBus.emit(`update:${deployment.id}`, deployment);
        }
      } catch (e) {
        deployment.logs.push(`⚠ Could not write .env: ${e.message}`);
      }
    } else if (detectedEnvFile && !fs.existsSync(path.join(targetDir, '.env'))) {
      // Safe fallback: copy .env.example -> .env so builds expecting variables don't crash
      try {
        fs.copyFileSync(detectedEnvFile, path.join(targetDir, '.env'));
        deployment.logs.push(`✓ Auto-initialized .env from ${path.basename(detectedEnvFile)} defaults.`);
        eventBus.emit(`update:${deployment.id}`, deployment);
      } catch (e) {}
    }

    // ----------------------------------------------------
    // STEP 2: INSTALLING DEPENDENCIES
    // ----------------------------------------------------
    deployment.step = 2;
    deployment.status = 'installing';
    deployment.logs.push('Running npm install (memory-optimized)...');
    eventBus.emit(`update:${deployment.id}`, deployment);

    const packageJsonPath = path.join(targetDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      await runCommand(
        'npm install --prefer-offline --no-audit --no-fund',
        targetDir,
        (log) => {
          deployment.logs.push(log);
          eventBus.emit(`update:${deployment.id}`, deployment);
        }
      );
      deployment.logs.push('✓ Dependencies installed.');
    } else {
      deployment.logs.push('ℹ No package.json found, skipping npm install.');
    }
    eventBus.emit(`update:${deployment.id}`, deployment);

    // ----------------------------------------------------
    // STEP 3: COMPILING BUNDLE
    // ----------------------------------------------------
    let hasBuildScript = false;
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        hasBuildScript = Boolean(pkg.scripts && pkg.scripts.build);
      } catch (e) {}
    }

    if (hasBuildScript) {
      deployment.step = 3;
      deployment.status = 'building';
      deployment.logs.push('Running build script: npm run build...');
      eventBus.emit(`update:${deployment.id}`, deployment);

      await runCommand(
        'npm run build',
        targetDir,
        (log) => {
          deployment.logs.push(log);
          eventBus.emit(`update:${deployment.id}`, deployment);
        }
      );
      deployment.logs.push('✓ Build script completed successfully.');
      eventBus.emit(`update:${deployment.id}`, deployment);
    }

    // ----------------------------------------------------
    // STEP 4: ALLOCATE PORT & START PREVIEW SERVER
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

    // OPTION 1: Clean up node_modules to reclaim ~300-500MB disk space per sandbox
    const nmPath = path.join(targetDir, 'node_modules');
    if (fs.existsSync(nmPath)) {
      fs.rm(nmPath, { recursive: true, force: true }, (rmErr) => {
        if (!rmErr) {
          deployment.logs.push('🧹 Option 1: Cleaned up node_modules to preserve VM disk space.');
          eventBus.emit(`update:${deployment.id}`, deployment);
        }
      });
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
    let cleanHost = rawHost.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    cleanHost = cleanHost.split(':')[0] || 'localhost';

    const liveUrl = `http://${cleanHost}:${port}`;
    deployment.url = liveUrl;

    // OPTION 2: Auto-expire TTL timer
    const ttlMinutes = SANDBOX_TTL_MINUTES || 60;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
    deployment.expiresAt = expiresAt;
    deployment.ttlMinutes = ttlMinutes;

    if (sandboxTimers.has(deployment.id)) {
      clearTimeout(sandboxTimers.get(deployment.id));
    }

    const timer = setTimeout(async () => {
      console.log(`⏳ Auto-expiring sandbox ${deployment.id} after ${ttlMinutes}m`);
      await stopAndRemoveDeployment(deployment.id, 'auto-expired');
    }, ttlMinutes * 60 * 1000);

    sandboxTimers.set(deployment.id, timer);

    // ----------------------------------------------------
    // STEP 4: LIVE!
    // ----------------------------------------------------
    deployment.step = 4;
    deployment.status = 'live';
    deployment.logs.push(`🎉 Deployment is LIVE at: ${liveUrl}`);
    deployment.logs.push(`⏳ Option 2: Auto-teardown scheduled in ${ttlMinutes} mins to free resources.`);
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
function createDeployment(id, repoName, repoUrl, host, envVars) {
  const deployment = {
    id,
    repoName,
    repoUrl,
    host,
    envVars,
    step: 1,
    status: 'cloning',
    logs: [`[${new Date().toLocaleTimeString()}] Worker accepted build for ${repoName}`],
    createdAt: new Date().toISOString(),
  };

  deployments.set(id, deployment);
  executeBuildPipeline(deployment);
  return deployment;
}

function createDeploymentFromFiles(id, repoName, files, host, envVars) {
  const deployment = {
    id,
    repoName,
    isUpload: true,
    files,
    host,
    envVars,
    step: 1,
    status: 'unpacking',
    logs: [`[${new Date().toLocaleTimeString()}] Worker accepted file upload bundle for ${repoName}`],
    createdAt: new Date().toISOString(),
  };

  deployments.set(id, deployment);
  executeBuildPipeline(deployment);
  return deployment;
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

function getDeployment(id) {
  return deployments.get(id);
}

function getRunningCount() {
  return runningServers.size;
}

module.exports = {
  createDeployment,
  createDeploymentFromFiles,
  getAllDeployments,
  getDeployment,
  getRunningCount,
  stopAndRemoveDeployment,
};
