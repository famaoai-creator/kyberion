const pty = require('node-pty');

console.log('Testing ULTRA-BASIC node-pty spawn...');
try {
  const p = pty.spawn('/bin/ls', [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: '/', // Minimum possible working directory
    env: { PATH: '/bin:/usr/bin' } // Minimum possible PATH
  });
  
  console.log('Spawn successful! PID:', p.pid);
  p.onData((data) => console.log('Data:', data));
  
  setTimeout(() => {
    p.kill();
    console.log('Test finished.');
  }, 1000);
} catch (err) {
  console.error('Spawn failed:', err);
}
