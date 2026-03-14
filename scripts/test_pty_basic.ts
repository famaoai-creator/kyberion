import * as pty from 'node-pty';
import * as os from 'node:os';

console.log('Testing node-pty spawn via login shell...');
try {
  const user = os.userInfo().username;
  // Use 'login' to wrap the shell, which often bypasses TCC/Sandbox restrictions for PTYs on macOS
  const p = pty.spawn('/usr/bin/login', ['-f', '-p', user, '/bin/sh'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env
  });
  
  console.log('Spawn successful! PID:', p.pid);
  p.onData((data) => console.log('Data:', data));
  p.write('echo "hello from pty via login"\r');
  
  setTimeout(() => {
    p.kill();
    console.log('Test finished.');
  }, 2000);
} catch (err) {
  console.error('Spawn failed:', err);
}
