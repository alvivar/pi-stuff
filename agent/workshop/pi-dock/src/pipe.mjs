import net from 'node:net';

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

  server.listen(pipePath);
  return server;
}

export function request(pipePath, msg, timeoutMs = 1000) {
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
