/**
 * Orphaned-server CPU spin (#180, #196) — end-to-end reproduction.
 *
 * The unit suite pins the stderr guard in isolation. This test exercises the
 * real failure: a built server whose client dies without closing it down.
 * Before the guard, the server spun at ~100% CPU indefinitely (observed alive
 * for 5 days in the field). It must now exit on its own.
 *
 * The client is simulated with a socketpair rather than a pipe because that is
 * what the reported JetBrains/Copilot launcher hands the server, and it is the
 * shape where all three descriptors die at once.
 *
 * The spawning helper must be the one to report the outcome: it owns the
 * server process, and an exited-but-unreaped child stays visible to
 * `kill(pid, 0)` as a zombie, which reads as "still running" from outside.
 *
 * Requires `npm run build`. Not part of the CI unit run.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const SERVER = path.resolve(process.cwd(), 'dist/index.js');

/** Seconds the server gets to notice its client is gone and exit. */
const EXIT_GRACE_SECONDS = 20;

const HARNESS = [
  'import socket, subprocess, sys, time',
  'parent, peer = socket.socketpair()',
  'p = subprocess.Popen([sys.argv[1], sys.argv[2]], stdin=peer.fileno(),',
  '                     stdout=peer.fileno(), stderr=peer.fileno(),',
  '                     pass_fds=(peer.fileno(),), cwd="/")',
  'peer.close()',
  'time.sleep(6)',
  'parent.close()', // the client dies here
  'for _ in range(int(sys.argv[3])):',
  '    if p.poll() is not None:',
  '        print("exited", flush=True); sys.exit(0)',
  '    time.sleep(1)',
  'cpu = subprocess.run(["ps","-o","%cpu=","-p",str(p.pid)],',
  '                     capture_output=True, text=True).stdout.strip()',
  'print("orphaned at " + cpu + "% CPU", flush=True)',
  'p.kill()',
].join('\n');

describe('orphaned server exits when its client dies', () => {
  it('does not outlive a client that vanished', async () => {
    expect(existsSync(SERVER)).toBe(true); // run `npm run build` first

    const harness = spawn(
      'python3',
      ['-c', HARNESS, process.execPath, SERVER, String(EXIT_GRACE_SECONDS)],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );

    const outcome = await new Promise<string>((resolve, reject) => {
      let out = '';
      harness.stdout.on('data', d => (out += String(d)));
      harness.once('error', reject);
      harness.once('close', () => resolve(out.trim()));
    });

    expect(outcome).toBe('exited');
  }, 60000);
});
