import net from 'net';

// DNS-rebinding guard for plain-HTTP `GET /health`. A page that points a name at the daemon sends
// that name as its Host, so only a Host the daemon itself owns may read the body. WebSocket upgrades
// are covered by the Origin rule (WebSocketServer.ts verifyClient) instead. "Any IP literal" is not
// accepted: an IP that is neither loopback nor the address the connection arrived on is refused.

// One bracketed IPv6 literal or one token with no whitespace and none of `:/?#@[]`, then an optional port.
const HOST = /^(?:\[([^\][\s]+)\]|([^\s:/?#@[\]]+))(?::(\d{1,5}))?$/;

function canonicalIpv6(inner: string): string {
  if (!net.isIPv6(inner)) throw new Error('not an IPv6 literal');
  // WHATWG URL canonicalizes the text and throws on a zone id.
  return new URL(`http://[${inner}]`).hostname.slice(1, -1);
}

// The arrival address as the host literal would spell it: a '::ffff:' mapped IPv4 loses its prefix.
function canonicalAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1] ?? address;
  if (net.isIPv4(mapped)) return mapped;
  try { return canonicalIpv6(mapped); } catch { return undefined; }
}

/**
 * @param host the request's Host header (undefined when none was sent)
 * @param localAddress `req.socket.localAddress`, the address the connection arrived on
 * Pure and total: any failure to parse refuses.
 */
export function isAllowedHealthHost(host: string | undefined, localAddress: string | undefined): boolean {
  try {
    if (host === undefined) return true; // a browser always sends a Host
    const match = HOST.exec(host);
    if (!match) return false;
    const port = match[3];
    if (port !== undefined && !(Number(port) >= 1 && Number(port) <= 65535)) return false;
    if (match[1] !== undefined) {
      const literal = canonicalIpv6(match[1]);
      return literal === '::1' || literal === canonicalAddress(localAddress);
    }
    const name = match[2].toLowerCase();
    if (name === 'localhost') return true;
    // Every other name, which is all a rebinding page can send, falls out here.
    if (!net.isIPv4(name)) return false;
    return name.startsWith('127.') || name === canonicalAddress(localAddress);
  } catch {
    return false;
  }
}
