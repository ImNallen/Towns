import * as THREE from 'three';

/**
 * Lighting is tuned so up-facing surfaces render at exactly their palette colour:
 * Lambert output = albedo · (ambient + sun · cosθ) / π, and we make that bracket equal π.
 * Shadowed ground keeps only the ambient share (~75% brightness).
 */
export const SUN_DIRECTION = new THREE.Vector3(-160, 300, -200).normalize(); // from the north-west
export const SUN_INTENSITY = 1.0;
export const AMBIENT_INTENSITY = Math.PI - SUN_INTENSITY * SUN_DIRECTION.y;
