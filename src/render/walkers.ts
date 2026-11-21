import * as THREE from 'three';
import { PALETTE } from './palette';

export class WalkerLayer {
  readonly group = new THREE.Group();
  private readonly pose = new THREE.Matrix4();
  private readonly coats = PALETTE.coats.map((c) => new THREE.Color(c));
  private readonly faces = PALETTE.faces.map((c) => new THREE.Color(c));
  private readonly geometry = new THREE.SphereGeometry(1, 10, 8);
  private readonly material = new THREE.MeshStandardMaterial();
  private parts: THREE.InstancedMesh[] = [];

  update(positions: Float32Array): void {
    const count = positions.length / 3;
    if (count > (this.parts[0]?.instanceMatrix.count ?? 0)) {
      for (const mesh of this.parts) {
        mesh.dispose();
        this.group.remove(mesh);
      }
      this.parts = Array.from({ length: 2 }, () => {
        const mesh = new THREE.InstancedMesh(this.geometry, this.material, Math.max(64, count));
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        this.group.add(mesh);
        return mesh;
      });
    }
    for (const [part, mesh] of this.parts.entries()) {
      mesh.count = count;
      const colours = part ? this.faces : this.coats;
      for (let i = 0; i < count; i++) {
        const x = positions[3 * i]!,
          y = positions[3 * i + 1]!,
          person = positions[3 * i + 2]!;
        if (part) this.pose.makeScale(0.68, 0.67, 0.68).setPosition(x, 1.65, -y - 0.38);
        else this.pose.makeScale(1.06, 0.73, 0.85).setPosition(x, 0.85, -y);
        mesh.setMatrixAt(i, this.pose);
        mesh.setColorAt(i, colours[person % colours.length]!);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}
