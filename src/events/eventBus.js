const { EventEmitter } = require('events');

/**
 * Global event bus to emit and listen for deployment progress updates.
 * Used by buildService to broadcast updates, and by SSE route to stream them.
 */
const eventBus = new EventEmitter();

module.exports = eventBus;
