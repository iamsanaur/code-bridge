/**
 * The string a phone or an agent needs to join a personal relay:
 *   codebridge://connect?server=<https url>&secret=<owner secret>
 * It carries the owner secret, so treat it like a password.
 */
export function connectLink(serverUrl: string, secret: string): string {
  return `codebridge://connect?server=${encodeURIComponent(serverUrl.replace(/\/$/, ''))}&secret=${encodeURIComponent(secret)}`;
}

export function parseConnectLink(link: string): { server: string; secret: string } | null {
  try {
    const u = new URL(link.trim());
    const server = u.searchParams.get('server');
    const secret = u.searchParams.get('secret');
    if (u.protocol !== 'codebridge:' || u.hostname !== 'connect' || !server || !secret) return null;
    return { server: server.replace(/\/$/, ''), secret };
  } catch {
    return null;
  }
}
