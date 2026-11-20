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

  debugLane: { road: '#2f6fe0', connector: '#f08a24', ring: '#d6338a' },
  debugYield: '#e03131',
} as const;
