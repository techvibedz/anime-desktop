export function createRequestCache<T>(ttlMs: number, now: () => number = Date.now) {
  const values = new Map<string, { value: T; ts: number }>();
  const inFlight = new Map<string, Promise<T>>();

  return {
    run(
      key: string,
      load: () => Promise<T>,
      options: { force?: boolean; valid?: (value: T) => boolean } = {},
    ): Promise<T> {
      const pending = inFlight.get(key);
      if (pending && !options.force) return pending;

      const cached = values.get(key);
      if (!options.force && cached && now() - cached.ts < ttlMs) {
        return Promise.resolve(cached.value);
      }
      if (cached && now() - cached.ts >= ttlMs) values.delete(key);

      let loading: Promise<T>;
      try {
        loading = Promise.resolve(load());
      } catch (error) {
        return Promise.reject(error);
      }
      const tracked = loading.then((value) => {
        if (!options.valid || options.valid(value)) values.set(key, { value, ts: now() });
        return value;
      }).finally(() => {
        if (inFlight.get(key) === tracked) inFlight.delete(key);
      });
      inFlight.set(key, tracked);
      return tracked;
    },
    delete(key: string) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  if (timeoutMs <= 0) return Promise.resolve(fallback);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
