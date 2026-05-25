/**
 * Frees the app port before dev start (avoids EADDRINUSE after watch restarts).
 * Uses PORT from .env / .env.local, default 3000.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const loadEnvFile = (filename) => {
  const filePath = path.join(__dirname, '..', filename);
  if (!fs.existsSync(filePath)) {
    return;
  }
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
};

loadEnvFile('.env');
loadEnvFile('.env.local');

const port = process.env.PORT || '3000';

try {
  const output = execSync(`netstat -ano | findstr ":${port}"`, { encoding: 'utf8' });
  const pids = new Set();

  for (const line of output.split('\n')) {
    if (!line.includes('LISTENING')) {
      continue;
    }
    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];
    if (pid && /^\d+$/.test(pid)) {
      pids.add(pid);
    }
  }

  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      console.log(`[free-port] Stopped PID ${pid} on port ${port}`);
    } catch {
      // process may have already exited
    }
  }
} catch {
  // nothing listening — ok
}
