const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function writeFileAtomic(file, content) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch (_) { /* already moved or unavailable */ }
    throw error;
  }
}

module.exports = { writeFileAtomic };
