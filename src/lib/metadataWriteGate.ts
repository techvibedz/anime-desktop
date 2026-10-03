export function createMetadataWriteGate(maxWrites: number, windowMs: number, keyCooldownMs: number) {
  const writes: number[] = [];
  const lastByKey = new Map<string, number>();
  return (key: string, now = Date.now()): boolean => {
    const last = lastByKey.get(key);
    if (last !== undefined && now - last < keyCooldownMs) return false;
    while (writes.length && now - writes[0] >= windowMs) writes.shift();
    if (writes.length >= maxWrites) return false;
    writes.push(now);
    lastByKey.set(key, now);
    return true;
  };
}
