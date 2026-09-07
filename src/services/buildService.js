const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { runCommand } = require('./commandRunner');
const { SANDBOXES_DIR, PUBLIC_HOST, SANDBOX_TTL_MINUTES } = require('../config/env');
const eventBus = require('../events/eventBus');
const {
  saveDeployment,
  getDeployment,
  getAllDeployments,
  deleteDeployment,
  closeServer,
  closeProcess,
  registerProcess,
  setTtlTimer,
  clearTtlTimer,
  getRunningCount,
} = require('./sandboxStore');
const { setupEnvironment } = require('./envDetector');
const { unpackFiles } = require('./unpackService');
const { launchPreviewServer } = require('./previewServerService');
const { getNextAvailablePort } = require('./portService');
const { startTunnel, stopTunnel } = require('./tunnelService');

// Ensure sandboxes directory exists
if (!fs.existsSync(SANDBOXES_DIR)) {
  fs.mkdirSync(SANDBOXES_DIR, { recursive: true });
}

function emitUpdate(id, deployment) {
  eventBus.emit(`update:${id}`, deployment);
}

/**
 * Stop running server/process and remove sandbox directory from disk (Option 3 & Option 2)
 */
async function stopAndRemoveDeployment(id, reason = 'manual') {
  const deployment = getDeployment(id);

  // 1. Clear TTL timer
  clearTtlTimer(id);

  // 2. Stop running Express preview server immediately (if frontend)
  closeServer(id);

  // 3. Stop running backend child process immediately (if backend)
  closeProcess(id);

  // 4. Terminate dynamic Cloudflare tunnel immediately
  stopTunnel(id);

  // 5. Remove deployment from registry immediately
  deleteDeployment(id);

  // 5. Update deployment state & emit event
  if (deployment) {
    deployment.status = reason === 'auto-expired' ? 'expired' : 'stopped';
    deployment.step = -99;
    deployment.url = null;
    if (!Array.isArray(deployment.logs)) deployment.logs = [];
    deployment.logs.push(`🛑 Sandbox terminated (${reason}) and disk cleaned.`);
    emitUpdate(id, deployment);
  }

  // 6. Delete the sandbox directory from VM disk asynchronously in background (no HTTP lag)
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
    // RESOLVE WORKING DIRECTORY (MONOREPO / ROOT DIR)
    // ----------------------------------------------------
    let workingDir = targetDir;
    if (deployment.rootDir && typeof deployment.rootDir === 'string') {
      const cleanRootDir = deployment.rootDir.trim().replace(/^\.?\/+/, '');
      if (cleanRootDir) {
        const candidateWorkingDir = path.join(targetDir, cleanRootDir);
        if (fs.existsSync(candidateWorkingDir) && fs.statSync(candidateWorkingDir).isDirectory()) {
          workingDir = candidateWorkingDir;
          deployment.logs.push(`📁 Configured Root Directory: /${cleanRootDir}`);
          notify();
        } else {
          deployment.logs.push(
            `⚠️ Specified Root Directory '/${cleanRootDir}' not found, falling back to repository root.`
          );
          notify();
        }
      }
    } else {
      // Smart Auto-detection: if root has no package.json and no HTML files, check for common monorepo subfolders
      const rootPkg = path.join(targetDir, 'package.json');
      let hasHtml = false;
      try {
        hasHtml = fs.readdirSync(targetDir).some((f) => f.toLowerCase().endsWith('.html'));
      } catch {}

      if (!fs.existsSync(rootPkg) && !hasHtml) {
        const candidates = ['frontend', 'client', 'web', 'ui', 'app', 'backend', 'server', 'api'];
        for (const cand of candidates) {
          const candPath = path.join(targetDir, cand);
          if (fs.existsSync(candPath) && fs.statSync(candPath).isDirectory()) {
            const candPkg = path.join(candPath, 'package.json');
            let candHasHtml = false;
            try {
              candHasHtml = fs.readdirSync(candPath).some((f) => f.toLowerCase().endsWith('.html'));
            } catch {}
            if (fs.existsSync(candPkg) || candHasHtml) {
              workingDir = candPath;
              deployment.rootDir = cand;
              deployment.logs.push(`🔍 Auto-detected monorepo project subfolder: /${cand}`);
              notify();
              break;
            }
          }
        }
      }
    }

    // ----------------------------------------------------
    // ENVIRONMENT SETUP & DETECTION (.env, .env.example)
    // ----------------------------------------------------
    setupEnvironment(workingDir, deployment, notify);

    // ----------------------------------------------------
    // STEP 2: INSTALLING DEPENDENCIES
    // ----------------------------------------------------
    deployment.step = 2;
    deployment.status = 'installing';
    deployment.logs.push('Running npm install (memory-optimized)...');
    notify();

    let pkg = null;
    const packageJsonPath = path.join(workingDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      await runCommand(
        'npm install --prefer-offline --no-audit --no-fund',
        workingDir,
        (log) => {
          deployment.logs.push(log);
          notify();
        }
      );
      deployment.logs.push('✓ Dependencies installed.');
      try {
        pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      } catch {}
    } else {
      deployment.logs.push('ℹ No package.json found, skipping npm install.');
    }
    notify();

    // ----------------------------------------------------
    // DETERMINE PROJECT TYPE (BACKEND vs FRONTEND)
    // ----------------------------------------------------
    const hasBuildScript = Boolean(pkg?.scripts && pkg?.scripts?.build);
    const hasStartScript = Boolean(pkg?.scripts && pkg?.scripts?.start);
    const isExplicitBackend = deployment.projectType === 'backend';
    const isExplicitFrontend = deployment.projectType === 'frontend';

    // Check if HTML files exist in working directory or public/
    let hasHtml = false;
    try {
      hasHtml =
        fs.existsSync(path.join(workingDir, 'index.html')) ||
        fs.existsSync(path.join(workingDir, 'public', 'index.html')) ||
        fs.readdirSync(workingDir).some((f) => f.toLowerCase().endsWith('.html'));
    } catch {}

    const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
    const hasBackendDeps = Boolean(
      deps.express ||
        deps.fastify ||
        deps.koa ||
        deps['@nestjs/core'] ||
        deps.hono ||
        deps.polka ||
        deps.restify ||
        deps.hapi ||
        deps.mongoose ||
        deps.pg ||
        deps.mysql2 ||
        deps.prisma ||
        deps['@prisma/client'] ||
        deps.typeorm ||
        deps.sequelize ||
        deps.sqlite3 ||
        deps.cors
    );

    const hasServerEntry = Boolean(
      [
        pkg?.main,
        'server.js',
        'server.ts',
        'app.js',
        'app.ts',
        'index.js',
        'index.ts',
        'src/server.js',
        'src/server.ts',
        'src/index.js',
        'src/index.ts',
        'src/app.js',
        'src/app.ts',
      ].some((f) => f && fs.existsSync(path.join(workingDir, f)))
    );

    // If an HTML file exists, it's a frontend web app, unless user explicitly selected 'backend'
    const isBackend =
      isExplicitBackend ||
      (!isExplicitFrontend &&
        !hasHtml &&
        (hasBackendDeps || (hasServerEntry && !hasHtml)));

    deployment.isBackend = isBackend;

    if (isBackend) {
      // If the backend has a build script (TypeScript, NestJS, Prisma generate), compile it first!
      if (hasBuildScript) {
        deployment.step = 2;
        deployment.status = 'building';
        deployment.logs.push('Compiling backend (npm run build)...');
        notify();

        await runCommand('npm run build', workingDir, (log) => {
          deployment.logs.push(log);
          notify();
        });
        deployment.logs.push('✓ Backend compiled successfully.');
        notify();
      }

      // --------------------------------------------------
      // LAUNCH NODE.JS BACKEND PROCESS
      // --------------------------------------------------
      deployment.step = 3;
      deployment.status = 'starting';
      deployment.logs.push('🚀 Starting Node.js backend server process...');
      notify();

      const port = await getNextAvailablePort(4001);
      deployment.port = port;

      let startCmd = 'npm';
      let startArgs = ['start'];
      if (!hasStartScript) {
        const entry =
          [
            pkg?.main,
            'dist/index.js',
            'dist/server.js',
            'dist/app.js',
            'build/index.js',
            'build/server.js',
            'server.js',
            'index.js',
            'app.js',
            'src/server.js',
            'src/index.js',
            'src/app.js',
            'src/server.ts',
            'src/index.ts',
            'src/app.ts',
          ].find((f) => f && fs.existsSync(path.join(workingDir, f))) || 'index.js';

        if (entry.endsWith('.ts')) {
          startCmd = 'npx';
          startArgs = ['tsx', entry];
        } else {
          startCmd = 'node';
          startArgs = [entry];
        }
      }

      const env = {
        ...process.env,
        PORT: String(port),
        HOST: '0.0.0.0',
        NODE_ENV: 'production',
        ...(deployment.envVars && typeof deployment.envVars === 'object'
          ? deployment.envVars
          : {}),
      };

      deployment.logs.push(`Executing: ${startCmd} ${startArgs.join(' ')} (PORT=${port})`);
      notify();

      const child = spawn(startCmd, startArgs, {
        cwd: workingDir,
        env,
        shell: true,
      });

      registerProcess(deployment.id, child);

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) {
          deployment.logs.push(text);
          notify();
        }
      });

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) {
          deployment.logs.push(`[backend] ${text}`);
          notify();
        }
      });

      child.on('error', (err) => {
        deployment.logs.push(`❌ Backend process error: ${err.message}`);
        notify();
      });

      child.on('exit', (code) => {
        if (code !== 0) {
          deployment.logs.push(`❌ Backend process exited with error code ${code}`);
          deployment.status = 'failed';
          deployment.step = -3;
          deployment.url = null;
          notify();
        }
      });

      // Compute Public URL
      const rawHost = (deployment.host || PUBLIC_HOST || '129.225.66.172').trim();
      let cleanHost =
        rawHost
          .replace(/^https?:\/\//i, '')
          .replace(/\/+$/, '')
          .split(':')[0] || '129.225.66.172';

      if (
        cleanHost === 'localhost' ||
        cleanHost === '127.0.0.1' ||
        cleanHost.includes('vercel.app')
      ) {
        cleanHost = '129.225.66.172';
      }

      const directUrl = `http://${cleanHost}:${port}`;
      deployment.directUrl = directUrl;

      let liveUrl = directUrl;
      if (process.env.ENABLE_CLOUDFLARE_TUNNEL === 'true') {
        deployment.logs.push('Provisioning dedicated Cloudflare HTTPS tunnel...');
        notify();
        const tunnelUrl = await startTunnel(deployment.id, port);
        if (tunnelUrl) {
          liveUrl = tunnelUrl;
        }
      } else if (cleanHost.includes('trycloudflare.com')) {
        liveUrl = `https://${cleanHost}/?_port=${port}`;
      }

      deployment.url = liveUrl;
      deployment.step = 4;
      deployment.status = 'live';
      deployment.logs.push(`✓ Backend API listening on port ${port} (${liveUrl})`);

      // Set TTL Timer
      const ttlMinutes = SANDBOX_TTL_MINUTES || 60;
      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
      deployment.expiresAt = expiresAt;
      deployment.ttlMinutes = ttlMinutes;

      const timer = setTimeout(async () => {
        console.log(`⏳ Auto-expiring backend sandbox ${deployment.id} after ${ttlMinutes}m`);
        await stopAndRemoveDeployment(deployment.id, 'auto-expired');
      }, ttlMinutes * 60 * 1000);

      setTtlTimer(deployment.id, timer);
      notify();
    } else {
      // --------------------------------------------------
      // STEP 3: COMPILING FRONTEND BUNDLE
      // --------------------------------------------------
      if (hasBuildScript) {
        deployment.step = 3;
        deployment.status = 'building';
        deployment.logs.push('Running build script: npm run build...');
        notify();

        await runCommand('npm run build', workingDir, (log) => {
          deployment.logs.push(log);
          notify();
        });
        deployment.logs.push('✓ Build script completed successfully.');
        notify();
      }

      // --------------------------------------------------
      // STEP 4: LAUNCH STATIC PREVIEW SERVER
      // --------------------------------------------------
      deployment.step = 3;
      deployment.status = 'starting';
      deployment.logs.push('Spawning sandbox preview server...');
      notify();

      await launchPreviewServer(workingDir, deployment, stopAndRemoveDeployment, notify);
    }
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

function createDeployment(id, repoName, repoUrl, host, envVars, rootDir, projectType) {
  const deployment = {
    id,
    repoName,
    repoUrl,
    host,
    envVars,
    rootDir: rootDir || '',
    projectType: projectType || 'auto',
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
