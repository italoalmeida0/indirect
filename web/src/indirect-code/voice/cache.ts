/** IndexedDB cache for self-hosted Parakeet v3 model blobs.
 * Guarded for environments without IndexedDB and Private Browsing quota limits.
 */

const DB_NAME = "parakeet-cache-db";
const DB_VERSION = 1;
const STORE_NAME = "file-store";
const KEY_PREFIX = "parakeet-v3-selfhost--";

let dbPromise: Promise<IDBDatabase> | null = null;

export function voiceCacheKey(filename: string): string {
  return `${KEY_PREFIX}${filename}`;
}

function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  if (!hasIndexedDb()) {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onerror = () => {
          dbPromise = null;
          reject(req.error ?? new Error("IndexedDB open failed"));
        };
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME);
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => {
            try {
              db.close();
            } catch {}
            dbPromise = null;
          };
          resolve(db);
        };
      } catch (err) {
        dbPromise = null;
        reject(err);
      }
    });
  }
  return dbPromise;
}

export async function idbGet(key: string): Promise<Blob | undefined> {
  if (!hasIndexedDb()) return undefined;
  try {
    const db = await openDb();
    return await new Promise<Blob | undefined>((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => {
        const val = req.result;
        resolve(val instanceof Blob && val.size > 0 ? val : undefined);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

/** Stores a Blob in IndexedDB. Returns false instead of throwing on
 * QuotaExceededError, Private Browsing restrictions, or unavailable IDB.
 */
export async function idbPut(key: string, blob: Blob): Promise<boolean> {
  if (!hasIndexedDb()) return false;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], "readwrite");
      const req = tx.objectStore(STORE_NAME).put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? req.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
    return true;
  } catch {
    return false;
  }
}

export async function idbDeleteKeys(keys: readonly string[]): Promise<void> {
  if (!hasIndexedDb() || keys.length === 0) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction([STORE_NAME], "readwrite");
      const store = tx.objectStore(STORE_NAME);
      for (let i = 0; i < keys.length; i++) {
        store.delete(keys[i]!);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {}
}
