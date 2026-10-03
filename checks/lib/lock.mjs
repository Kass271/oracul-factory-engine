// Stack lock: one Docker-stack operation (up, down, e2e) at a time per app — state/apps/<app>/stack.lock.
// A second operation waits up to `waitS` seconds, then gives up (stack.mjs exits 3 "STACK BUSY"). A lock whose
// process is gone, or that is older than STALE_MS (pid reuse), is stale and taken over. A live lock is never deleted.
import fs from 'node:fs';
import path from 'node:path';

export const STALE_MS = 45 * 60 * 1000;

// process.kill(pid, 0): ESRCH = gone; EPERM = alive but owned by another user.
export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function isStale(lock, now = Date.now()) {
  if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0) return true;
  const t = Date.parse(lock.startedAt);
  return !Number.isFinite(t) || now - t > STALE_MS || !alive(lock.pid);
}

function tryCreate(file, cmd) {
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, cmd, startedAt: new Date().toISOString() }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

// Remove the lock only if it still holds exactly the stale content we judged (another process may have replaced it).
function removeStale(file, seen, log) {
  const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (now !== seen) return true; // changed meanwhile — look again
  const old = readLock(file) || {};
  try { fs.unlinkSync(file); } catch { return false; }
  log(`stale stack lock (${old.cmd ?? '?'}, pid ${old.pid ?? '?'}) removed`);
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// → { ok: true, release } | { ok: false, holder }
export async function acquire(file, cmd, { waitS = 240, pollMs = 5000, log = console.log } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t0 = Date.now();
  let lastNote = t0;
  for (;;) {
    if (tryCreate(file, cmd)) {
      let done = false;
      const release = () => {
        if (done) return;
        done = true;
        if (readLock(file)?.pid === process.pid) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
      };
      process.on('exit', release);
      return { ok: true, release };
    }
    const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const holder = readLock(file);
    // An unreadable lock younger than 5 s is being written right now — treat it as live.
    const young = !holder && raw !== null && (() => { try { return Date.now() - fs.statSync(file).mtimeMs < 5000; } catch { return false; } })();
    if (raw !== null && !young && isStale(holder) && removeStale(file, raw, log)) continue;
    if (raw === null) continue; // released between our attempts
    if (Date.now() - t0 >= waitS * 1000) return { ok: false, holder: holder || {} };
    if (Date.now() - lastNote >= 60_000) {
      lastNote = Date.now();
      log(`waiting for stack lock: ${holder?.cmd} by pid ${holder?.pid} since ${holder?.startedAt}`);
    }
    await sleep(Math.min(pollMs, Math.max(0, waitS * 1000 - (Date.now() - t0))));
  }
}
