/** All colours used on the map. Flat surfaces render at exactly these values (see lighting in scene.ts). */
export const PALETTE = {
  ground: '#ecebe4',
  water: '#b7c3f0',
  sand: '#f0e3ad',
  hills: ['#8f8e88', '#9c9b95', '#a9a8a2', '#b6b5af', '#c3c2bc'],

  roadSurface: '#ffffff',
  roadOutline: '#a3a29c',
  centerLine: '#e6c440',
  giveWay: '#8a8983',

  houses: ['#a6cf5f', '#9bc756', '#b0d56d'],
  vehicles: ['#5b7fd6', '#7aa7e8', '#58b38f', '#e4c04c', '#e07f5f', '#9a7fd1', '#4f9fb5', '#d9d9d4'],
  vehicleGlass: '#5d6577',
  /** Residents' cars by household car model (1 = oldest, 3 = newest). */
  carModels: ['#b8a58c', '#3f7f8c', '#c2414f'],

  gardens: ['#d8dfc8', '#e2e6d2', '#dbe2cb'],
  orchard: ['#829b79', '#94ab87', '#a2b491'],
  cottageRoofs: ['#bc8876', '#94a6aa', '#d0ad83', '#a3aaa1'],

  editorHandle: '#21705d',
  editorPreview: '#8ecbb5',
  editorInvalid: '#bb5941',
  buildBoundary: '#aaa99b',
  editorPaper: '#fffdf4',

  debugLane: { road: '#2f6fe0', connector: '#f08a24', ring: '#d6338a' },
  debugYield: '#e03131',
} as const;
