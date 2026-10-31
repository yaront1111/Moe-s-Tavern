// Extra HTTP listeners forward upgrades to the primary, rather than owning a
// second WSS: every connection must share its state and Origin verifier.
import http from 'http';
import { isIPv4, type AddressInfo, type Socket } from 'net';
import type os from 'os';

export const WSL_BIND_HOST = 'wsl';

export function resolveBindHosts(host: string, interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[] {
  if (host !== WSL_BIND_HOST) return [host];
  const hosts = new Set(['127.0.0.1']);
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!name.toLowerCase().startsWith('vethernet (wsl')) continue;
    for (const entry of entries ?? []) {
      if (['IPv4', 4].includes(entry.family) && entry.internal === false
          && isIPv4(entry.address) && entry.address !== '0.0.0.0') hosts.add(entry.address);
    }
  }
  return [...hosts];
}

async function listen(server: http.Server, host: string, port: number): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const ready = () => { server.off('error', failed); resolve(); };
      const failed = (error: Error) => { server.off('listening', ready); reject(error); };
      server.once('error', failed);
      server.once('listening', ready);
      try { server.listen(port, host); }
      catch (error) { server.off('error', failed); failed(error as Error); }
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.message = `Failed to listen on ${host}: ${failure.message}`;
    throw failure;
  }
}

export async function listenOnHosts(
  primary: http.Server, hosts: readonly string[], port: number, handler: http.RequestListener,
): Promise<http.Server[]> {
  if (hosts.length === 0) throw new Error('At least one bind host is required');
  const servers: http.Server[] = [];
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  try {
    for (const [index, host] of hosts.entries()) {
      const server = index === 0 ? primary : http.createServer(handler);
      if (index > 0) server.on('upgrade', (req, socket, head) => primary.emit('upgrade', req, socket, head));
      servers.push(server);
      server.on('connection', track);
      await listen(server, host, port);
      port = (primary.address() as AddressInfo).port;
    }
    return servers;
  } catch (error) {
    // Include upgraded sockets: HTTP closeAllConnections alone does not close them.
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    throw error;
  } finally {
    for (const server of servers) server.off('connection', track);
    sockets.clear();
  }
}
