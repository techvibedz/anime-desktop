import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { storage } from "./storage";

export type CardLayout = "compact" | "comfortable" | "list";

/** Every full-page grid owns its saved layout; changing one never affects another. */
export type CardLayoutScope =
  | "search"
  | "mylist"
  | "upcoming"
  | "seasons"
  | "popular"
  | "see-all"
  | "related"
  | "title"
  | "manga-search"
  | "manga-library";

const KEY_PREFIX = "@settings_card_layout:";
const DEFAULT_LAYOUT: CardLayout = "compact";

export const CARD_LAYOUTS: readonly CardLayout[] = ["compact", "comfortable", "list"];
export const isCardLayout = (value: unknown): value is CardLayout =>
  value === "compact" || value === "comfortable" || value === "list";
/** Next layout in the press-to-cycle order. */
export function nextCardLayout(value: CardLayout): CardLayout {
  return CARD_LAYOUTS[(CARD_LAYOUTS.indexOf(value) + 1) % CARD_LAYOUTS.length];
}

type ScopeStore = {
  current: CardLayout;
  revision: number;
  hydration?: Promise<void>;
  writes: Promise<void>;
  listeners: Set<() => void>;
};

const stores = new Map<CardLayoutScope, ScopeStore>();

function storeFor(scope: CardLayoutScope): ScopeStore {
  let store = stores.get(scope);
  if (!store) {
    store = { current: DEFAULT_LAYOUT, revision: 0, writes: Promise.resolve(), listeners: new Set() };
    stores.set(scope, store);
  }
  return store;
}

export const getCardLayout = (scope: CardLayoutScope): CardLayout => storeFor(scope).current;

export function subscribeCardLayout(scope: CardLayoutScope, listener: () => void): () => void {
  const store = storeFor(scope);
  store.listeners.add(listener);
  return () => { store.listeners.delete(listener); };
}

export function hydrateCardLayout(scope: CardLayoutScope): Promise<void> {
  const store = storeFor(scope);
  if (!store.hydration) {
    const startedAt = store.revision;
    store.hydration = storage.getItem(KEY_PREFIX + scope).then((saved) => {
      if (store.revision === startedAt && isCardLayout(saved) && store.current !== saved) {
        store.current = saved;
        for (const listener of store.listeners) listener();
      }
    }).catch(() => {});
  }
  return store.hydration;
}

export function setCardLayout(scope: CardLayoutScope, value: CardLayout): Promise<void> {
  const store = storeFor(scope);
  if (!isCardLayout(value)) return store.writes;
  store.revision++;
  if (store.current !== value) {
    store.current = value;
    for (const listener of store.listeners) listener();
  }
  // Serialize quick taps per page so an older write can't become the saved choice.
  store.writes = store.writes.then(() => storage.setItem(KEY_PREFIX + scope, value)).catch(() => {});
  return store.writes;
}

// Desktop sizing: columns follow the available width with a minimum poster
// width per density (the mobile port fixed 2/3 columns, which rendered three
// giant posters across a desktop window). The sidebar is subtracted.
const SIDEBAR_W = 256;
const MIN_CARD_W: Record<CardLayout, number> = { comfortable: 168, compact: 128, list: 10_000 };

export function cardLayoutMetrics(layout: CardLayout, viewportWidth: number, gap = 12, padding = 32) {
  const contentWidth = Math.max(1, viewportWidth - SIDEBAR_W - padding * 2);
  const columns = layout === "list" ? 1 : Math.max(2, Math.floor((contentWidth + gap) / (MIN_CARD_W[layout] + gap)));
  // Floor to 2dp so float epsilon can't overflow a flexWrap grid and wrap a
  // card onto its own line (which reads as a huge gap).
  const cardWidth = Math.floor(((contentWidth - gap * (columns - 1)) / columns) * 100) / 100;
  return { columns, cardWidth, contentWidth };
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

export function useCardLayout(scope: CardLayoutScope, gap = 12, padding = 20) {
  const width = useViewportWidth();
  // Stable per-scope identities; useSyncExternalStore resubscribes if they change.
  const subscribe = useMemo(() => (listener: () => void) => subscribeCardLayout(scope, listener), [scope]);
  const snapshot = useMemo(() => () => getCardLayout(scope), [scope]);
  const layout = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => { void hydrateCardLayout(scope); }, [scope]);
  return {
    layout,
    setLayout: useMemo(() => (value: CardLayout) => setCardLayout(scope, value), [scope]),
    ...cardLayoutMetrics(layout, width, gap, padding),
  };
}
