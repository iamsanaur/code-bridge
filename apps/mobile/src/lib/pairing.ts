import { pairingCodeSchema } from '@codebridge/protocol';

/** Extracts the user code from a scanned `codebridge://pair?code=…` link. */
export function codeFromQr(data: string): string | null {
  try {
    const url = new URL(data);
    if (url.protocol !== 'codebridge:') return null;
    const code = url.searchParams.get('code');
    const parsed = pairingCodeSchema.safeParse(code ?? '');
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
