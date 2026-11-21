import type { LandUse } from '../sim/zoning/paint';

/** All colours used on the map. Flat surfaces render at exactly these values (see lighting in scene.ts). */
export const PALETTE = {
  building: {
    walls: {
      chalk: '#ece9de', cream: '#e5d9be', stone: '#cec8b6', mist: '#c1ced1',
      precast: '#b8bfc0', blueConcrete: '#9caaae', aluminium: '#d0d5d4',
      brick: '#c48e7c', ochre: '#ddc395', celadon: '#becdb8', rose: '#ddbfb6',
    },
    roofs: {
      zinc: '#87969a', gunmetal: '#66777e', galvalume: '#a1acac',
      slate: '#82949e', terracotta: '#b9816c', charcoal: '#969591', moss: '#919b7d', tan: '#bdab8e',
    },
    industrial: {
      apron: '#c4c4ba', glass: '#c3dfe0', flashing: '#dce1db', grille: '#56656a',
      timber: '#b89676', strap: '#677473', marking: '#ede9d9',
    },
    awning: '#568c81', chimney: '#c79f86',
    trim: '#f5f0df', hedge: '#819774', trunk: '#9b8467', pool: '#94becb',
  },
  light: '#ffffff',
  ground: '#ecebe4',
  water: '#b7c3f0',
  sand: '#f0e3ad',
  hills: ['#8f8e88', '#9c9b95', '#a9a8a2', '#b6b5af', '#c3c2bc'],

  signal: { red: '#da5247', amber: '#f2ae32', green: '#42a874', case: '#343e41' },
  traffic: { free: '#77bca0', slow: '#edb554', jammed: '#d86852', marker: '#783f37' },
  roadSurface: '#ffffff',
  coats: ['#9f4937', '#275c77', '#776395', '#d59936', '#28786c'],
  faces: ['#ecc69b', '#c79570', '#ab7757'],
  crossing: '#6c7372',
  pavement: '#e2ded1',
  parking: '#d3d6ce',
  parkingFree: '#8ac8a2',
  parkingFull: '#e38865',
  roadOutline: '#a3a29c',
  centerLine: '#e6c440',
  giveWay: '#8a8983',

  houses: ['#a6cf5f', '#9bc756', '#b0d56d'],
  vehicles: ['#5b7fd6', '#7aa7e8', '#58b38f', '#e4c04c', '#e07f5f', '#9a7fd1', '#4f9fb5', '#d9d9d4'],
  vehicleGlass: '#5d6577',

  gardens: ['#d8dfc8', '#e2e6d2', '#dbe2cb'],
  yardGravel: '#d6c9b3',
  orchard: ['#829b79', '#94ab87', '#a2b491'],
  cottageRoofs: ['#bc8876', '#94a6aa', '#d0ad83', '#a3aaa1'],

  editorHandle: '#21705d',
  editorPreview: '#8ecbb5',
  editorInvalid: '#bb5941',
  buildBoundary: '#aaa99b',
  zoneGrid: '#d9d8cf',
  parkBench: '#976b49',
  parkPath: '#dbcfad',
  parkLawn: '#a9c887',
  zonePaint: { park: '#b6ca98', parking: '#84aaa9', residential: '#d4e3ad', shops: '#9bcbd3', workplaces: '#e3be85' } satisfies Record<LandUse, string>,
  editorPaper: '#fffdf4',
  selection: '#21705d',

  debugLane: { road: '#2f6fe0', connector: '#f08a24', ring: '#d6338a' },
  debugYield: '#e03131',
} as const;
