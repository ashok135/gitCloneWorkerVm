const fs = require('fs');
const path = require('path');

/**
 * Safely unpacks an array of uploaded files into a target directory
 */
async function unpackFiles(targetDir, files, deployment, emitUpdate) {
  if (fs.existsSync(targetDir)) {
    await fs.promises.rm(targetDir, { recursive: true, force: true });
  }
  fs.mkdirSync(targetDir, { recursive: true });

  if (Array.isArray(files)) {
    for (const file of files) {
      if (!file || !file.path) continue;

      // Prevent directory traversal vulnerabilities (e.g. ../../)
      const safePath = path.normalize(file.path).replace(/^(\.\.[\/\\])+/, '');
      const fullFilePath = path.join(targetDir, safePath);
      const dirName = path.dirname(fullFilePath);

      if (!fs.existsSync(dirName)) {
        fs.mkdirSync(dirName, { recursive: true });
      }

      if (file.encoding === 'base64') {
        fs.writeFileSync(fullFilePath, Buffer.from(file.content, 'base64'));
      } else {
        fs.writeFileSync(fullFilePath, file.content || '', 'utf8');
      }
    }
  }

  // Auto-alias: if no index.html exists, but an HTML file was uploaded, copy to index.html
  const indexPath = path.join(targetDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    try {
      const allFiles = fs.readdirSync(targetDir);
      const anyHtml = allFiles.find((f) => f.toLowerCase().endsWith('.html'));
      if (anyHtml) {
        fs.copyFileSync(path.join(targetDir, anyHtml), indexPath);
        deployment.logs.push(`✓ Auto-aliased ${anyHtml} -> index.html for direct browser hosting.`);
      }
    } catch (e) {}
  }

  // Free memory after writing files to disk
  delete deployment.files;

  deployment.logs.push('✓ Files unpacked successfully into sandbox.');
  emitUpdate();
}

module.exports = {
  unpackFiles,
};
