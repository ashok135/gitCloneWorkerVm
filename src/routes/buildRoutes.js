const express = require('express');
const {
  triggerBuild,
  getBuildStatus,
  streamBuildProgress,
  getHealth,
} = require('../controllers/buildController');

const router = express.Router();

router.post('/build', triggerBuild);
router.get('/status/:id', getBuildStatus);
router.get('/stream/:id', streamBuildProgress);
router.get('/health', getHealth);

module.exports = router;
