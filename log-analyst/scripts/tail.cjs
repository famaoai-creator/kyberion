const fs = require('fs');
const { runSkill } = require('@agent/core');

const logFile = process.argv[2];
const linesToRead = parseInt(process.argv[3] || '100', 10);

if (!logFile || !fs.existsSync(logFile)) {
  console.error('Usage: node log-analyst/scripts/tail.cjs <log_file> [lines]');
  process.exit(1);
}

runSkill('log-analyst', () => {
  const stats = fs.statSync(logFile);
  const fileSize = stats.size;
  const bufferSize = 1024 * 100; // Read 100kb chunk from end
  const buffer = Buffer.alloc(bufferSize);

  const fd = fs.openSync(logFile, 'r');
  const start = Math.max(0, fileSize - bufferSize);
  const bytesToRead = Math.min(bufferSize, fileSize);

  const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, start);
  fs.closeSync(fd);

  const content = buffer.toString('utf8', 0, bytesRead);
  const lines = content.split('\n');
  const lastLines = lines.slice(-linesToRead);

  return {
    logFile,
    totalSize: fileSize,
    linesReturned: lastLines.length,
    content: lastLines.join('\n'),
  };
});
