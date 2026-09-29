// Low-poly unit bodies (skins) and weapons, merged into single geometries so
// each crowd renders in one instanced draw call.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

function part(geo: THREE.BufferGeometry, shade: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.deleteAttribute('uv');
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
  g.applyMatrix4(m);
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3).fill(shade);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g = g.toNonIndexed();
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

const BODY = 0.8;
const HEAD = 1.0;
const DARK = 0.35;

export function unitGeometry(skin: string): THREE.BufferGeometry {
  switch (skin) {
    case 'bot':
      return merge([
        part(new THREE.BoxGeometry(0.3, 0.32, 0.22), BODY, 0, 0.28, 0),
        part(new THREE.BoxGeometry(0.26, 0.22, 0.24), HEAD, 0, 0.58, 0),
        part(new THREE.BoxGeometry(0.18, 0.05, 0.02), DARK, 0, 0.6, -0.125),
        part(new THREE.CylinderGeometry(0.015, 0.015, 0.14, 4), DARK, 0, 0.76, 0),
        part(new THREE.BoxGeometry(0.08, 0.14, 0.08), BODY, -0.09, 0.07, 0),
        part(new THREE.BoxGeometry(0.08, 0.14, 0.08), BODY, 0.09, 0.07, 0),
      ]);
    case 'blob':
      return merge([
        part(new THREE.SphereGeometry(0.22, 10, 8), BODY, 0, 0.22, 0, 0, 0, 0, 1, 0.95, 1),
        part(new THREE.SphereGeometry(0.05, 6, 5), DARK, -0.07, 0.3, -0.19),
        part(new THREE.SphereGeometry(0.05, 6, 5), DARK, 0.07, 0.3, -0.19),
      ]);
    case 'wizard':
      return merge([
        part(new THREE.ConeGeometry(0.2, 0.46, 8), BODY, 0, 0.23, 0),
        part(new THREE.SphereGeometry(0.12, 8, 6), HEAD, 0, 0.53, 0),
        part(new THREE.ConeGeometry(0.15, 0.3, 8), DARK, 0, 0.74, 0, -0.2),
        part(new THREE.CylinderGeometry(0.17, 0.17, 0.02, 10), DARK, 0, 0.6, 0),
      ]);
    case 'knight':
      return merge([
        part(new THREE.CylinderGeometry(0.15, 0.17, 0.36, 8), BODY, 0, 0.26, 0),
        part(new THREE.BoxGeometry(0.24, 0.24, 0.24), HEAD, 0, 0.58, 0),
        part(new THREE.BoxGeometry(0.18, 0.04, 0.02), DARK, 0, 0.6, -0.125),
        part(new THREE.BoxGeometry(0.04, 0.12, 0.2), HEAD, 0, 0.76, 0),
        part(new THREE.BoxGeometry(0.08, 0.1, 0.08), DARK, -0.08, 0.05, 0),
        part(new THREE.BoxGeometry(0.08, 0.1, 0.08), DARK, 0.08, 0.05, 0),
      ]);
    case 'ninja':
      return merge([
        part(new THREE.CapsuleGeometry(0.14, 0.24, 3, 8), DARK + 0.2, 0, 0.3, 0),
        part(new THREE.SphereGeometry(0.13, 8, 6), DARK + 0.2, 0, 0.62, 0),
        part(new THREE.BoxGeometry(0.28, 0.05, 0.28), BODY + 0.2, 0, 0.64, 0),
        part(new THREE.BoxGeometry(0.03, 0.04, 0.2), BODY + 0.2, 0.05, 0.64, 0.16, 0.4),
      ]);
    case 'brute':
      return merge([
        part(new THREE.CapsuleGeometry(0.2, 0.26, 3, 8), BODY, 0, 0.34, 0),
        part(new THREE.SphereGeometry(0.15, 8, 6), HEAD, 0, 0.72, 0),
        part(new THREE.ConeGeometry(0.04, 0.14, 5), 1.2, -0.1, 0.84, 0, 0, 0, 0.4),
        part(new THREE.ConeGeometry(0.04, 0.14, 5), 1.2, 0.1, 0.84, 0, 0, 0, -0.4),
      ]);
    case 'neutral':
    case 'classic':
    default:
      return merge([
        part(new THREE.CapsuleGeometry(0.15, 0.24, 3, 8), BODY, 0, 0.3, 0),
        part(new THREE.SphereGeometry(0.13, 8, 6), HEAD, 0, 0.62, 0),
        part(new THREE.SphereGeometry(0.035, 5, 4), DARK, -0.05, 0.64, -0.115),
        part(new THREE.SphereGeometry(0.035, 5, 4), DARK, 0.05, 0.64, -0.115),
      ]);
  }
}

export function weaponGeometry(id: string): { geo: THREE.BufferGeometry; color: string } | null {
  switch (id) {
    case 'sword':
      return { geo: merge([part(new THREE.BoxGeometry(0.04, 0.34, 0.02), 1, 0.2, 0.5, -0.05), part(new THREE.BoxGeometry(0.12, 0.03, 0.04), 0.6, 0.2, 0.34, -0.05)]), color: '#d9dde3' };
    case 'spear':
      return { geo: merge([part(new THREE.CylinderGeometry(0.015, 0.015, 0.8, 4), 0.55, 0.2, 0.45, -0.1), part(new THREE.ConeGeometry(0.04, 0.12, 5), 1, 0.2, 0.9, -0.1)]), color: '#c8b59a' };
    case 'shield':
      return { geo: merge([part(new THREE.CylinderGeometry(0.13, 0.13, 0.03, 10), 1, -0.18, 0.34, -0.02, 0, 0, Math.PI / 2)]), color: '#e0b43a' };
    case 'hammer':
      return { geo: merge([part(new THREE.CylinderGeometry(0.015, 0.015, 0.45, 4), 0.55, 0.2, 0.45, -0.05), part(new THREE.BoxGeometry(0.16, 0.1, 0.1), 1, 0.2, 0.7, -0.05)]), color: '#9aa3ad' };
    case 'staff':
      return { geo: merge([part(new THREE.CylinderGeometry(0.018, 0.018, 0.7, 4), 0.6, 0.2, 0.4, -0.05), part(new THREE.IcosahedronGeometry(0.06, 0), 1.3, 0.2, 0.78, -0.05)]), color: '#7fd8ff' };
    default:
      return null;
  }
}
