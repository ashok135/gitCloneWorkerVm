const fs = require('fs');
const path = require('path');

const CANDIDATE_FILES = [
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.local.example',
];

/**
 * Detects .env template files and applies configured or default environment variables
 */
function setupEnvironment(targetDir, deployment, emitUpdate) {
  let detectedEnvFile = null;

  for (const candidate of CANDIDATE_FILES) {
    const fullPath = path.join(targetDir, candidate);
    if (fs.existsSync(fullPath)) {
      detectedEnvFile = fullPath;
      break;
    }
  }

  if (detectedEnvFile) {
    try {
      const content = fs.readFileSync(detectedEnvFile, 'utf8');
      const lines = content
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && l.includes('='));
      const keys = lines.map((l) => l.split('=')[0].trim());

      deployment.detectedEnv = {
        file: path.basename(detectedEnvFile),
        keys,
        template: content,
      };

      deployment.logs.push(
        `ℹ Environment setup: detected ${path.basename(detectedEnvFile)} with ${keys.length} variable(s): [${keys.join(', ')}]`
      );
      emitUpdate();
    } catch (e) {
      console.warn('Failed to parse env template:', e);
    }
  }

  // 1. If user provided custom environment variables
  if (deployment.envVars) {
    try {
      let content = '';
      if (typeof deployment.envVars === 'string') {
        content = deployment.envVars;
      } else if (typeof deployment.envVars === 'object') {
        content = Object.entries(deployment.envVars)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n');
      }

      if (content.trim()) {
        fs.writeFileSync(path.join(targetDir, '.env'), content, 'utf8');
        deployment.logs.push('✓ Applied user-configured environment variables (.env).');
        emitUpdate();
      }
    } catch (e) {
      deployment.logs.push(`⚠ Could not write .env: ${e.message}`);
    }
  } else if (detectedEnvFile && !fs.existsSync(path.join(targetDir, '.env'))) {
    // 2. Fallback: Copy .env.example -> .env so builds don't fail missing keys
    try {
      fs.copyFileSync(detectedEnvFile, path.join(targetDir, '.env'));
      deployment.logs.push(
        `✓ Auto-initialized .env from ${path.basename(detectedEnvFile)} defaults.`
      );
      emitUpdate();
    } catch (e) {}
  }
}

module.exports = {
  setupEnvironment,
};
