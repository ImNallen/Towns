import * as THREE from 'three';
import { polyline } from '../sim/math/polyline';
import { parksOn } from '../sim/town/parks';
import { decodeCellKey, findCell, type ZoneCells } from '../sim/zoning/cells';
import type { Zoning } from '../sim/zoning/paint';
import { flatMaterial, FlatMesh } from './flat';
import { PALETTE } from './palette';

export function buildParks(cells: ZoneCells, zoning: Zoning): THREE.Group {
  const group = new THREE.Group();
  const lawn = new FlatMesh(0.087),
    paths = new FlatMesh(0.11);
  const canopy = new THREE.IcosahedronGeometry(1, 1);
  const wood = new THREE.BoxGeometry();
  for (const park of parksOn(cells, zoning)) {
    const frontKeys=park.cells.filter(key=>decodeCellKey(key).row===0);
    const entrance=frontKeys.reduce((p,key)=>{
      const k=findCell(cells,key)*8;
      p.x+=(cells.corners[k]!+cells.corners[k+2]!)/(2*frontKeys.length);
      p.y+=(cells.corners[k+1]!+cells.corners[k+3]!)/(2*frontKeys.length);
      return p;
    },{x:0,y:0});
    if (frontKeys.length) paths.ribbon(polyline([entrance,park]),1.3);
    if (park.cells.length >=4) {
      const radius=Math.min(4.5,Math.sqrt(park.cells.length)*1.45);
      const ring=Array.from({length:18},(_,i)=>({x:park.x+radius*Math.cos(i*Math.PI/9),y:park.y+radius*Math.sin(i*Math.PI/9)}));
      paths.ribbon(polyline(ring,true),1.05);
    }
    for (const [index, key] of park.cells.entries()) {
      const offset = 8 * findCell(cells, key);
      const points = Array.from({ length: 4 }, (_, i) => ({
        x: cells.corners[offset + 2 * i]!,
        y: cells.corners[offset + 2 * i + 1]!,
      }));
      const [a, b, c, d] = points;
      lawn.quad(a!, b!, c!, d!);
      const position = (u: number, v: number) => ({
        x: (1 - v) * (a!.x + (b!.x - a!.x) * u) + v * (d!.x + (c!.x - d!.x) * u),
        y: (1 - v) * (a!.y + (b!.y - a!.y) * u) + v * (d!.y + (c!.y - d!.y) * u),
      });

      if (index % 2 === 0) {
        const tree = new THREE.Mesh(canopy, flatMaterial(PALETTE.orchard[index % 3]!));
        const p = position(index % 4 ? 0.33 : 0.20, index % 3 ? 0.75 : 0.67);
        tree.scale.set(2, 2.4, 2);
        tree.position.set(p.x, 2.35, -p.y);
        tree.castShadow = true;
        group.add(tree);
      }
      if (index % 3 === 0) {
        const p = position(0.78, 0.28);
        const bench = new THREE.Mesh(wood, flatMaterial(PALETTE.parkBench));
        bench.scale.set(2.5, 0.55, 0.72);
        bench.rotation.y = Math.atan2(b!.y - a!.y, b!.x - a!.x);
        bench.position.set(p.x, 0.5, -p.y);
        bench.castShadow = true;
        group.add(bench);
      }
    }
  }
  if (!lawn.empty) group.add(new THREE.Mesh(lawn.build(), flatMaterial(PALETTE.parkLawn)));
  if (!paths.empty) group.add(new THREE.Mesh(paths.build(), flatMaterial(PALETTE.parkPath)));
  return group;
}
