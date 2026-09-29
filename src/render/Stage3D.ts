import * as THREE from 'three';
import { GAME } from '../config/gameConfig';

export class Stage3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly hemi: THREE.HemisphereLight;
  readonly sun: THREE.DirectionalLight;
  private quality: 'high' | 'low' = 'high';

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(GAME.camera.fov, 1, 0.5, 600);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x88aa66, 1);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.2);
    this.sun.position.set(-6, 14, 6);
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setQuality(q: 'high' | 'low'): void {
    this.quality = q;
    this.resize();
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 2 : 1);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Portrait phones need a wider vertical FOV to see the full track width.
    this.camera.fov = w / h < 0.75 ? GAME.camera.fov + 12 : GAME.camera.fov;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** World position → CSS pixel coordinates (null if behind camera) */
  project(v: THREE.Vector3, out: { x: number; y: number }): boolean {
    const p = _v.copy(v).project(this.camera);
    if (p.z > 1) return false;
    out.x = (p.x * 0.5 + 0.5) * window.innerWidth;
    out.y = (-p.y * 0.5 + 0.5) * window.innerHeight;
    return true;
  }
}

const _v = new THREE.Vector3();
