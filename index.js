const express = require('express');
const cors = require('cors');
const { PORT, PUBLIC_HOST } = require('./src/config/env');
const buildRoutes = require('./src/routes/buildRoutes');

const { reverseProxyMiddleware } = require('./src/services/proxyGateway');

const app = express();

// Middlewares
app.use(cors());

// Reverse Proxy Gateway: Forward traffic to sandbox ports (4001, 4002, etc.)
app.use(reverseProxyMiddleware);

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Mount routes
app.use('/', buildRoutes);

// Error handler for body-parser / payload limits
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({
      error: 'Payload Too Large: Uploaded files exceed the 100MB limit.',
    });
  }
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Mini-Vercel Worker running on http://0.0.0.0:${PORT}`);
  console.log(`Public Preview Host: ${PUBLIC_HOST}`);
});
