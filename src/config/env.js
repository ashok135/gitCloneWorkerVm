const path = require('path');
require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 4000,
  PUBLIC_HOST: process.env.PUBLIC_HOST || 'nathan-bulk-somehow-get.trycloudflare.com',
  SANDBOXES_DIR: path.resolve(__dirname, '../../sandboxes'),
  SANDBOX_TTL_MINUTES: parseInt(process.env.SANDBOX_TTL_MINUTES || '60', 10),
};
