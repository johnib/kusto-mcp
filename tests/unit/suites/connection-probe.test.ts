/**
 * #315: azure-kusto-data drops the socket error code on its cloud-metadata
 * lookup, so after an unclassified connect failure we probe the host once.
 * Uses the real probe (setup.ts mocks it for every other suite) against local
 * sockets only.
 */

import net from 'node:net';

const { probeReachability } = jest.requireActual(
  '../../../src/common/connection-hints.js',
) as typeof import('../../../src/common/connection-hints.js');

function listen(): Promise<net.Server> {
  return new Promise(resolve => {
    const server = net.createServer(socket => socket.destroy());
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('probeReachability (#315)', () => {
  test('a listening host is reachable (undefined)', async () => {
    const server = await listen();
    const { port } = server.address() as net.AddressInfo;
    try {
      await expect(
        probeReachability(`https://127.0.0.1:${port}`, 2000),
      ).resolves.toBeUndefined();
    } finally {
      server.close();
    }
  });

  test('a closed port is connection_refused', async () => {
    const server = await listen();
    const { port } = server.address() as net.AddressInfo;
    await new Promise(r => server.close(r));
    await expect(
      probeReachability(`https://127.0.0.1:${port}`, 2000),
    ).resolves.toBe('connection_refused');
  });

  test('an unresolvable host is dns_resolution', async () => {
    // RFC 6761: .invalid never resolves.
    await expect(
      probeReachability('https://kusto-mcp-probe.invalid', 5000),
    ).resolves.toBe('dns_resolution');
  });

  test('a malformed URL never throws', async () => {
    await expect(probeReachability('not a url', 100)).resolves.toBeUndefined();
  });
});
