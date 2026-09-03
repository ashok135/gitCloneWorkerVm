const net = require('net');

/**
 * Checks if a TCP port is available to listen on.
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '0.0.0.0');
  });
}

/**
 * Finds the next available port on the machine starting from startPort.
 */
async function getNextAvailablePort(startPort = 4001) {
  let port = startPort;
  while (!(await isPortAvailable(port))) {
    port++;
    if (port > 4999) {
      throw new Error('No open ports found between 4001 and 4999');
    }
  }
  return port;
}

module.exports = {
  isPortAvailable,
  getNextAvailablePort,
};
