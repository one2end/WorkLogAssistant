const fs = require('fs');
const path = require('path');

function copyMissingData(source, destination, directories) {
  const srcRoot = path.resolve(source);
  const destRoot = path.resolve(destination);
  const a = process.platform === 'win32' ? srcRoot.toLowerCase() : srcRoot;
  const b = process.platform === 'win32' ? destRoot.toLowerCase() : destRoot;
  if (a === b) return 0;
  if (b.startsWith(a + path.sep)) throw new Error('目标目录不能位于当前数据目录内');

  let copied = 0;
  for (const name of directories) {
    const from = path.join(srcRoot, name);
    if (!fs.existsSync(from)) continue;
    const pending = [[from, path.join(destRoot, name)]];
    while (pending.length) {
      const [srcDir, destDir] = pending.pop();
      fs.mkdirSync(destDir, { recursive: true });
      for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const src = path.join(srcDir, entry.name);
        const dest = path.join(destDir, entry.name);
        if (entry.isDirectory()) pending.push([src, dest]);
        else if (entry.isFile()) {
          try {
            fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
            copied += 1;
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
        }
      }
    }
  }
  return copied;
}

module.exports = { copyMissingData };
