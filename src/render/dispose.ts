import * as THREE from 'three';

/** Release map layers whose geometry changes after a street edit. */
export function disposeLayer(layer: THREE.Object3D): void {
  layer.removeFromParent();
  layer.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Line)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material.dispose();
    if (object instanceof THREE.InstancedMesh) object.dispose();
  });
}
