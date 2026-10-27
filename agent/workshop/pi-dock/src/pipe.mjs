import { mkdir, rmdir, unlink } from 'node:fs/promises';
import net from 'node:net';

export const PIPE_REQUEST_TIMEOUT_MS = 3000;
const STALE_SOCKET_PROBE_TIMEOUT_MS = 500;

// Another process owns the pipe, or holds its acquisition lock.
export class PipeTakenError extends Error {
  constructor(pipePath) {
    super(`pipe taken: ${pipePath}`);
    this.name = 'PipeTakenError';
  }
}

// Unix only: the directory a runner holds while it acquires the socket.
export function acquisitionLock(socketPath) {
  return `${socketPath}.lock`;
}

function probeUnixSocket(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;

    function finish(result) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    }

    const timer = setTimeout(() => finish('alive'), STALE_SOCKET_PROBE_TIMEOUT_MS);

    socket.on('connect', () => finish('alive'));
    socket.on('error', (error) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
        finish('stale');
        return;
      }

      finish('error');
    });
  });
}

function listen(server, pipePath) {
  return new Promise((resolve, reject) => {
    function onListening() {
      server.off('error', onError);
      resolve();
    }
    function onError(error) {
      server.off('listening', onListening);
      reject(error);
    }
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(pipePath);
  });
}

async function listenOrTaken(server, pipePath) {
  try {
    await listen(server, pipePath);
  } catch (error) {
    throw error.code === 'EADDRINUSE' ? new PipeTakenError(pipePath) : error;
  }
}

// A Unix socket file outlives an owner that crashed, so a taken path is probed, and a socket
// nobody answers is stale and replaced.
async function listenOrRecover(server, socketPath) {
  try {
    await listen(server, socketPath);
    return;
  } catch (error) {
    if (error.code !== 'EADDRINUSE') {
      throw error;
    }
  }

  const result = await probeUnixSocket(socketPath);
  if (result === 'alive') {
    throw new PipeTakenError(socketPath);
  }
  if (result === 'error') {
    // Not contention: the probe itself failed, so this must not read as another runner owning it.
    throw new Error(`cannot probe socket: ${socketPath}`);
  }
  await unlink(socketPath).catch((error) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });
  await listenOrTaken(server, socketPath);
}

// The whole acquisition, first listen included, holds a lock directory, so two runners never act
// on the same probe result: neither replaces a socket the other just bound. Once listening, the
// listener is the ownership token and the lock goes. A lock left by a runner killed meanwhile
// blocks the agent until removed by hand; it is never stolen.
async function listenUnix(server, socketPath) {
  const lock = acquisitionLock(socketPath);
  try {
    await mkdir(lock);
  } catch (error) {
    throw error.code === 'EEXIST' ? new PipeTakenError(socketPath) : error;
  }

  let failure;
  try {
    await listenOrRecover(server, socketPath);
  } catch (error) {
    failure = error;
  }
  try {
    await rmdir(lock);
  } catch (error) {
    const after = failure ? ` (after: ${failure.message})` : '';
    throw new Error(`cannot remove ${lock}: ${error.message}${after}`, { cause: failure });
  }
  if (failure) {
    throw failure;
  }
}

// Resolves with the server once it listens; rejects with PipeTakenError if another runner owns
// the pipe or is acquiring it.
export async function serve(pipePath, handler) {
  const server = net.createServer((socket) => {
    let buffer = '';

    socket.setEncoding('utf8');

    socket.on('data', (chunk) => {
      buffer += chunk;

      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) {
          break;
        }

        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);

        if (line.length === 0) {
          continue;
        }

        void Promise.resolve()
          .then(() => handler(JSON.parse(line)))
          .then((reply) => {
            if (!socket.destroyed) {
              socket.write(`${JSON.stringify(reply)}\n`);
            }
          })
          .catch((error) => {
            if (!socket.destroyed) {
              socket.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
            }
          });
      }
    });

    socket.on('error', () => {});
  });

  if (process.platform === 'win32') {
    await listenOrTaken(server, pipePath);
  } else {
    await listenUnix(server, pipePath);
  }

  return server;
}

export function request(pipePath, msg, timeoutMs = PIPE_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let buffer = '';
    let settled = false;

    function finish(error, reply) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      socket.destroy();

      if (error) {
        reject(error);
      } else {
        resolve(reply);
      }
    }

    const timer = timeoutMs === null ? undefined : setTimeout(() => {
      const error = new Error(`pipe request timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      finish(error);
    }, timeoutMs);

    socket.setEncoding('utf8');

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(msg)}\n`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');

      if (newline === -1) {
        return;
      }

      try {
        finish(null, JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        finish(error);
      }
    });

    socket.on('error', finish);
    socket.on('close', () => finish(new Error('pipe closed before reply')));
  });
}
