import { storage } from "./storage";
import { resetLocalHistory } from "./history";
import { resetLocalFavorites } from "./favorites";
import { resetLocalCompletion } from "./completion";
import { resetLocalManga } from "./manga/store";
import { resetLocalNotifications } from "./notifications";

// Watch history, favorites, completion, manga and the notification center live
// on the device and are MERGED into the account on sign-in. Sign-out used to
// leave them behind, so the next account on the same PC inherited (and
// re-uploaded) the previous person's episodes. The owner id marks whose data
// is on the device; a different account wipes it before any sync runs.
// Mirrors mobile lib/accountData.ts.
const OWNER_KEY = "@local_data_owner";
let knownOwner: string | null = null;

async function wipeAccountLocalData(): Promise<void> {
  await Promise.all([
    resetLocalHistory(),
    resetLocalFavorites(),
    resetLocalCompletion(),
    resetLocalManga(),
    resetLocalNotifications(),
  ].map((p) => p.catch(() => {})));
}

/** Call before any cloud sync for a signed-in user. Same account → no-op.
 *  Legacy installs with no owner yet adopt the current account. */
export async function claimLocalData(userId: string): Promise<void> {
  if (knownOwner === userId) return;
  const owner = await storage.getItem(OWNER_KEY).catch(() => null);
  if (owner && owner !== userId) await wipeAccountLocalData();
  if (owner !== userId) await storage.setItem(OWNER_KEY, userId).catch(() => {});
  knownOwner = userId;
}

/** Explicit sign-out: the next person on this PC starts clean. */
export async function releaseLocalData(): Promise<void> {
  await wipeAccountLocalData();
  await storage.removeItem(OWNER_KEY).catch(() => {});
  knownOwner = null;
}
