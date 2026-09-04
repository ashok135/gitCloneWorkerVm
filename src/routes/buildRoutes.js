const express = require('express');
const {
  triggerBuild,
  deployFromFiles,
  getActiveSandboxes,
  getBuildStatus,
  streamBuildProgress,
  stopSandbox,
  getHealth,
} = require('../controllers/buildController');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ message: 'Mini-Vercel Worker is running!', status: 'ok' });
});
router.post('/build', triggerBuild);
router.post('/deploy-files', deployFromFiles);
router.get('/sandboxes', getActiveSandboxes);
router.get('/status/:id', getBuildStatus);
router.get('/stream/:id', streamBuildProgress);
router.delete('/sandbox/:id', stopSandbox);
router.post('/stop/:id', stopSandbox);
router.get('/health', getHealth);

module.exports = router;
