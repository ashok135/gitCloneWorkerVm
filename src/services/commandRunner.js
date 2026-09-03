const { exec } = require('child_process');
const eventBus = require('../events/eventBus');

/**
 * Runs a terminal command inside `cwd` and appends stdout/stderr to deployment logs.
 * Emits real-time progress events to the SSE stream.
 */
function runCommand(cmd, cwd, deployment) {
  return new Promise((resolve, reject) => {
    deployment.logs.push(`$ ${cmd}`);
    eventBus.emit(`update:${deployment.id}`, deployment);

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

    child.stdout?.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      deployment.logs.push(...lines);
      eventBus.emit(`update:${deployment.id}`, deployment);
    });

    child.stderr?.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      deployment.logs.push(...lines);
      eventBus.emit(`update:${deployment.id}`, deployment);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const errMsg = `Command exited with code ${code}: ${cmd}`;
        deployment.logs.push(errMsg);
        eventBus.emit(`update:${deployment.id}`, deployment);
        reject(new Error(errMsg));
      }
    });

    child.on('error', (err) => {
      deployment.logs.push(`Execution error: ${err.message}`);
      eventBus.emit(`update:${deployment.id}`, deployment);
      reject(err);
    });
  });
}

module.exports = {
  runCommand,
};
