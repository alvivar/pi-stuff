import { unlink } from 'node:fs/promises';
import net from 'node:net';

export const PIPE_REQUEST_TIMEOUT_MS = 3000;
const STALE_SOCKET_PROBE_TIMEOUT_MS = 500;

function emitServerError(server, message, code) {
  const error = new Error(message);
  error.code = code;
  error.piDockFatal = true;
  server.emit('error', error);
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

async function recoverUnixListen(server, socketPath) {
  const result = await probeUnixSocket(socketPath);
  if (result === 'stale') {
    await unlink(socketPath).catch((error) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
    server.listen(socketPath);
    return;
  }

  emitServerError(server, result === 'alive' ? 'already-running' : `cannot probe socket: ${socketPath}`, 'EADDRINUSE');
}

function listenUnix(server, socketPath) {
  let recovering = false;

  server.on('error', (error) => {
    if (error.piDockFatal || error.code !== 'EADDRINUSE') {
      return;
    }

    if (recovering) {
      emitServerError(server, 'already-running', 'EADDRINUSE');
      return;
    }

    recovering = true;
    error.piDockRetrying = true;
    void recoverUnixListen(server, socketPath).catch((recoverError) => {
      recoverError.piDockFatal = true;
      server.emit('error', recoverError);
    });
  });

  server.listen(socketPath);
}

export function serve(pipePath, handler) {
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
    server.listen(pipePath);
  } else {
    listenUnix(server, pipePath);
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

    const timer = setTimeout(() => {
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
    socket.on('end', () => finish(new Error('pipe closed before reply')));
    socket.on('close', () => finish(new Error('pipe closed before reply')));
  });
}
