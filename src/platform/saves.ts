export const slots = ['Town 1', 'Town 2', 'Town 3', 'Autosave'] as const;
export type Slot = typeof slots[number];

export interface SaveStorage {
  read(slot: Slot): string;
  write(slot: Slot, json: string): void;
  exportFile(json: string): void;
  importFile(file: File): Promise<string>;
}

export const browserSaves: SaveStorage = {
  read(slot) {
    let json;
    try { json = localStorage.getItem('towns.save.' + slot); }
    catch { throw new Error('Browser storage is unavailable.'); }
    if (!json) throw new Error(slot + ' is empty.');
    return json;
  },
  write(slot, json) {
    try { localStorage.setItem('towns.save.' + slot, json); }
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
