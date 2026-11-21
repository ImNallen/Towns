import * as THREE from 'three';
import { endOf } from '../sim/math/polyline';
import type { Network } from '../sim/network/types';
import type { TrafficView } from '../sim/traffic/conditions';
import { FlatMesh } from './flat';
import { PALETTE } from './palette';

export class TrafficLayer {
  readonly group = new THREE.Group();
  private readonly bands: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[];
  private readonly marker = new THREE.Mesh(new THREE.RingGeometry(5, 6.5, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: PALETTE.traffic.marker, depthTest: false }));

  constructor(private readonly network: Network) {
    this.bands = network.lanes.map(lane => {
      const ribbon = new FlatMesh(0.18);
      ribbon.ribbon(lane.path, 3.1);
      const mesh = new THREE.Mesh(ribbon.build(), new THREE.MeshBasicMaterial());
      this.group.add(mesh);
      return mesh;
    });
    this.group.add(this.marker);
    this.marker.renderOrder = 5;
    this.marker.visible = false;
  }

  update(view: TrafficView) {
    for (const lane of this.network.lanes) {
      const ratio = view.ratio[lane.id]!;
      const level = ratio >= 2 ? 'jammed' : ratio >= 1.3 ? 'slow' : 'free';
      this.bands[lane.id]!.material.color.set(PALETTE.traffic[level]);
    }
    this.marker.visible = view.worst >= 0;
    if (view.worst >= 0) {
      const p = endOf(this.network.lanes[view.worst]!.path);
      this.marker.position.set(p.x, 2, -p.y);
    }
  }
}
