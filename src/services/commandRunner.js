const { exec } = require('child_process');
const eventBus = require('../events/eventBus');

/**
 * Runs a terminal command inside `cwd` and appends stdout/stderr to deployment logs.
 * Accepts either:
 * - onLog callback function: (logText) => void
 * - deployment object: { id, logs: [] }
 */
function runCommand(cmd, cwd, deploymentOrOnLog) {
  return new Promise((resolve, reject) => {
    const handleLog = (msg) => {
      if (typeof deploymentOrOnLog === 'function') {
        deploymentOrOnLog(msg);
      } else if (deploymentOrOnLog) {
        if (!Array.isArray(deploymentOrOnLog.logs)) {
          deploymentOrOnLog.logs = [];
        }
        deploymentOrOnLog.logs.push(msg);
        eventBus.emit(`update:${deploymentOrOnLog.id}`, deploymentOrOnLog);
      }
    };

    handleLog(`$ ${cmd}`);

    // Limits Node memory to 512MB to safeguard 1GB RAM Oracle VMs
    const child = exec(cmd, {
      cwd,
      env: {
        ...process.env,
        NODE_OPTIONS: '--max-old-space-size=512',
        CI: 'true',
      },
      maxBuffer: 10 * 1024 * 1024,
    });

    if (child.stdout) {
      child.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        lines.forEach(handleLog);
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        lines.forEach(handleLog);
      });
    }

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const errMsg = `Command exited with code ${code}: ${cmd}`;
        handleLog(errMsg);
        reject(new Error(errMsg));
      }
    });

    child.on('error', (err) => {
      handleLog(`Execution error: ${err.message}`);
      reject(err);
    });
  });
}

module.exports = {
  runCommand,
};
