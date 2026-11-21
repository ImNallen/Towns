export const slots = ['Town 1', 'Town 2', 'Town 3', 'Autosave'] as const;
export type Slot = typeof slots[number];

export interface SaveStorage {
  read(slot: Slot): Promise<string>;
  write(slot: Slot, json: string): Promise<void>;
  exportFile(json: string): void;
  importFile(file: File): Promise<string>;
}

// Snapshot slots can exceed the shared localStorage quota. Retain read access to
// replay-only slots written by older builds until the player overwrites them.
function openSlots(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('towns-saves', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('slots');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function slotTransaction(slot: Slot, json?: string): Promise<string | undefined> {
  const db = await openSlots();
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      const tx = db.transaction('slots', json === undefined ? 'readonly' : 'readwrite');
      const store = tx.objectStore('slots');
      const request = json === undefined ? store.get(slot) : store.put(json, slot);
      tx.oncomplete = () => resolve(json === undefined ? request.result : undefined);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export const browserSaves: SaveStorage = {
  async read(slot) {
    let json;
    try { json = await slotTransaction(slot); }
    catch {
      // Private browsing can deny IndexedDB and still permit older local slots.
    }
    if (json === undefined) {
      try { json = localStorage.getItem('towns.save.' + slot); }
      catch { throw new Error('Browser storage is unavailable.'); }
    }
    if (!json) throw new Error(slot + ' is empty.');
    return json;
  },
  async write(slot, json) {
    try { await slotTransaction(slot, json); }
    catch { throw new Error('Could not save to browser storage. Export a file to keep your town.'); }
  },
  exportFile(json) {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'towns-save.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  importFile: file => file.text(),
};
