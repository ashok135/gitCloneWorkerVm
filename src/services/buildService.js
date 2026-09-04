const path = require('path');
const fs = require('fs');
const { runCommand } = require('./commandRunner');
const { SANDBOXES_DIR } = require('../config/env');
const eventBus = require('../events/eventBus');
const {
  saveDeployment,
  getDeployment,
  getAllDeployments,
  deleteDeployment,
  closeServer,
  clearTtlTimer,
  getRunningCount,
} = require('./sandboxStore');
const { setupEnvironment } = require('./envDetector');
const { unpackFiles } = require('./unpackService');
const { launchPreviewServer } = require('./previewServerService');

// Ensure sandboxes directory exists
if (!fs.existsSync(SANDBOXES_DIR)) {
  fs.mkdirSync(SANDBOXES_DIR, { recursive: true });
}

function emitUpdate(id, deployment) {
  eventBus.emit(`update:${id}`, deployment);
}

/**
 * Stop running server and remove sandbox directory from disk (Option 3 & Option 2)
 */
async function stopAndRemoveDeployment(id, reason = 'manual') {
  const deployment = getDeployment(id);

  // 1. Clear TTL timer
  clearTtlTimer(id);

  // 2. Stop running Express preview server immediately
  closeServer(id);

  // 3. Remove deployment from registry immediately
  deleteDeployment(id);

  // 4. Update deployment state & emit event
  if (deployment) {
    deployment.status = reason === 'auto-expired' ? 'expired' : 'stopped';
    deployment.step = -99;
    deployment.url = null;
    deployment.logs.push(`🛑 Sandbox terminated (${reason}) and disk cleaned.`);
    emitUpdate(id, deployment);
  }

  // 5. Delete the sandbox directory from VM disk asynchronously in background (no HTTP lag)
  const targetDir = path.join(SANDBOXES_DIR, id);
  if (fs.existsSync(targetDir)) {
    fs.promises
      .rm(targetDir, { recursive: true, force: true })
      .then(() => console.log(`🗑️ Deleted sandbox directory ${targetDir}`))
      .catch((err) => console.error(`Error deleting sandbox directory ${targetDir}:`, err.message));
  }

  return true;
}

/**
 * Execute the build & deploy pipeline
 */
async function executeBuildPipeline(deployment) {
  if (!Array.isArray(deployment.logs)) {
    deployment.logs = [];
  }
  const targetDir = path.join(SANDBOXES_DIR, deployment.id);
  const notify = () => emitUpdate(deployment.id, deployment);

  try {
    // ----------------------------------------------------
    // STEP 1: CLONING REPOSITORY OR UNPACKING FILES
    // ----------------------------------------------------
    deployment.step = 1;
    if (deployment.isUpload) {
      deployment.status = 'unpacking';
      deployment.logs.push(
        `Unpacking ${deployment.files?.length || 0} uploaded project files into sandbox...`
      );
      notify();
      await unpackFiles(targetDir, deployment.files, deployment, notify);
    } else {
      deployment.status = 'cloning';
      deployment.logs.push(`Cloning repository ${deployment.repoUrl}...`);
      notify();

      if (fs.existsSync(targetDir)) {
        await fs.promises.rm(targetDir, { recursive: true, force: true });
      }

      await runCommand(
        `git clone --depth 1 "${deployment.repoUrl}" "${targetDir}"`,
        SANDBOXES_DIR,
        (log) => {
          deployment.logs.push(log);
          notify();
        }
      );

      deployment.logs.push('✓ Repository cloned successfully.');
      notify();
    }

    // ----------------------------------------------------
    // ENVIRONMENT SETUP & DETECTION (.env, .env.example)
    // ----------------------------------------------------
    setupEnvironment(targetDir, deployment, notify);

    // ----------------------------------------------------
    // STEP 2: INSTALLING DEPENDENCIES
    // ----------------------------------------------------
    deployment.step = 2;
    deployment.status = 'installing';
    deployment.logs.push('Running npm install (memory-optimized)...');
    notify();

    const packageJsonPath = path.join(targetDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      await runCommand(
        'npm install --prefer-offline --no-audit --no-fund',
        targetDir,
        (log) => {
          deployment.logs.push(log);
          notify();
        }
      );
      deployment.logs.push('✓ Dependencies installed.');
    } else {
      deployment.logs.push('ℹ No package.json found, skipping npm install.');
    }
    notify();

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
      notify();

      await runCommand('npm run build', targetDir, (log) => {
        deployment.logs.push(log);
        notify();
      });
      deployment.logs.push('✓ Build script completed successfully.');
      notify();
    }

    // ----------------------------------------------------
    // STEP 4: LAUNCH PREVIEW SERVER & SCHEDULE TTL (OPTION 2)
    // ----------------------------------------------------
    deployment.step = 3;
    deployment.status = 'starting';
    deployment.logs.push('Spawning sandbox preview server...');
    notify();

    await launchPreviewServer(targetDir, deployment, stopAndRemoveDeployment, notify);
  } catch (err) {
    const failedStep = deployment.step || 1;
    deployment.step = -failedStep;
    deployment.status = 'failed';
    deployment.error = err.message || 'Build failed';
    if (!Array.isArray(deployment.logs)) {
      deployment.logs = [];
    }
    deployment.logs.push(`❌ Error: ${deployment.error}`);
    notify();
  }
}

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

  saveDeployment(id, deployment);
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
    logs: [
      `[${new Date().toLocaleTimeString()}] Worker accepted file upload bundle for ${repoName}`,
    ],
    createdAt: new Date().toISOString(),
  };

  saveDeployment(id, deployment);
  executeBuildPipeline(deployment);
  return deployment;
}

module.exports = {
  createDeployment,
  createDeploymentFromFiles,
  getDeployment,
  getAllDeployments,
  getRunningCount,
  deleteDeployment,
  stopAndRemoveDeployment,
};
