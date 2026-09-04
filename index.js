const express = require('express');
const cors = require('cors');
const { PORT, PUBLIC_HOST } = require('./src/config/env');
const buildRoutes = require('./src/routes/buildRoutes');

const app = express();

// Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Mount routes
app.use('/', buildRoutes);

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Mini-Vercel Worker running on http://0.0.0.0:${PORT}`);
  console.log(`Public Preview Host: ${PUBLIC_HOST}`);
});
