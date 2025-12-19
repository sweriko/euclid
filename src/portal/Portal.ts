import * as THREE from "three";

/**
 * Portal class representing a single portal in the world.
 * Portals come in pairs - each portal has a linked destination portal.
 *
 * The stencil-based portal rendering works as:
 * 1. Render portal quad to stencil buffer only (marks portal region)
 * 2. Render destination world where stencil is set
 * 3. Render current world normally
 */
export class Portal {
  /** Unique identifier for this portal */
  public readonly id: string;

  /** The portal quad mesh (used for stencil mask) */
  public readonly mesh: THREE.Mesh;

  /** The portal's position in world space */
  public readonly position: THREE.Vector3;

  /** The portal's rotation (quaternion) */
  public readonly quaternion: THREE.Quaternion;

  /** Portal dimensions */
  public readonly width: number;
  public readonly height: number;

  /** The linked destination portal */
  private _linkedPortal: Portal | null = null;

  /** The scene this portal belongs to */
  public scene: THREE.Scene | null = null;

  /** Portal normal (points outward from the portal surface) */
  private _normal: THREE.Vector3;

  /** Material for stencil-only rendering */
  private _stencilMaterial: THREE.MeshBasicMaterial;

  constructor(
    id: string,
    width: number,
    height: number,
    position: THREE.Vector3,
    rotation?: THREE.Euler
  ) {
    this.id = id;
    this.width = width;
    this.height = height;
    this.position = position.clone();
    this.quaternion = new THREE.Quaternion();

    if (rotation) {
      this.quaternion.setFromEuler(rotation);
    }

    // Create portal geometry (centered at bottom edge, extends up)
    const geometry = new THREE.PlaneGeometry(width, height);
    geometry.translate(0, height / 2, 0);

    // Stencil-only material: writes to stencil buffer, no color/depth writes
    this._stencilMaterial = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilZPass: THREE.ReplaceStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilFail: THREE.KeepStencilOp,
    });

    this.mesh = new THREE.Mesh(geometry, this._stencilMaterial);
    this.mesh.position.copy(this.position);
    this.mesh.quaternion.copy(this.quaternion);

    // Calculate normal (local +Z transformed by rotation)
    this._normal = new THREE.Vector3(0, 0, 1);
    this._normal.applyQuaternion(this.quaternion);
  }

  /**
   * Link this portal to its destination portal
   */
  link(portal: Portal): void {
    this._linkedPortal = portal;
    if (portal._linkedPortal !== this) {
      portal.link(this);
    }
  }

  /**
   * Get the linked destination portal
   */
  get linkedPortal(): Portal | null {
    return this._linkedPortal;
  }

  /**
   * Get the portal's outward-facing normal vector
   */
  get normal(): THREE.Vector3 {
    return this._normal.clone();
  }

  /**
   * Get the portal plane (for clipping)
   */
  getPlane(): THREE.Plane {
    return new THREE.Plane().setFromNormalAndCoplanarPoint(
      this._normal,
      this.position
    );
  }

  /**
   * Get the center of the portal (at mid-height)
   */
  getCenter(): THREE.Vector3 {
    const center = this.position.clone();
    const up = new THREE.Vector3(0, this.height / 2, 0);
    up.applyQuaternion(this.quaternion);
    center.add(up);
    return center;
  }

  /**
   * Calculate the camera position/rotation when viewing through this portal
   * to the destination portal.
   *
   * The transformation maps the viewer's position relative to this portal
   * to the equivalent position relative to the destination portal (rotated 180°).
   */
  getDestinationCameraTransform(
    viewerPosition: THREE.Vector3,
    viewerQuaternion: THREE.Quaternion
  ): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
    if (!this._linkedPortal) {
      return {
        position: viewerPosition.clone(),
        quaternion: viewerQuaternion.clone(),
      };
    }

    const dest = this._linkedPortal;

    // 1. Get viewer position relative to this portal
    const relativePos = viewerPosition.clone().sub(this.position);

    // 2. Transform to portal's local space
    const srcInverse = this.quaternion.clone().invert();
    relativePos.applyQuaternion(srcInverse);

    // 3. Rotate 180° (walking through flips you around)
    relativePos.x = -relativePos.x;
    relativePos.z = -relativePos.z;

    // 4. Transform to destination portal's world space
    relativePos.applyQuaternion(dest.quaternion);

    // 5. Add destination portal position
    const destPosition = relativePos.add(dest.position);

    // 6. Calculate destination rotation (180° flip around Y)
    const flipY = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI
    );
    const destQuaternion = new THREE.Quaternion()
      .copy(dest.quaternion)
      .multiply(flipY)
      .multiply(srcInverse)
      .multiply(viewerQuaternion);

    return { position: destPosition, quaternion: destQuaternion };
  }

  /**
   * Check if a point is on the "front" side of the portal
   * (the side from which you can see through the portal)
   */
  isPointInFront(point: THREE.Vector3): boolean {
    const toPoint = point.clone().sub(this.position);
    return toPoint.dot(this._normal) > 0;
  }

  /**
   * Get signed distance from point to portal plane
   */
  getSignedDistance(point: THREE.Vector3): number {
    const toPoint = point.clone().sub(this.position);
    return toPoint.dot(this._normal);
  }

  /**
   * Check if a point is within the portal bounds (in XY plane)
   */
  isPointInBounds(point: THREE.Vector3, margin: number = 0): boolean {
    // Transform point to portal local space
    const localPoint = point.clone().sub(this.position);
    const invQuat = this.quaternion.clone().invert();
    localPoint.applyQuaternion(invQuat);

    const halfWidth = this.width / 2 + margin;

    return (
      Math.abs(localPoint.x) <= halfWidth &&
      localPoint.y >= -margin &&
      localPoint.y <= this.height + margin
    );
  }

  /**
   * Update the mesh transform (call if position/rotation changes)
   */
  updateMesh(): void {
    this.mesh.position.copy(this.position);
    this.mesh.quaternion.copy(this.quaternion);
    this._normal.set(0, 0, 1).applyQuaternion(this.quaternion);
  }

  /**
   * Set the stencil reference value (for multiple portals)
   */
  setStencilRef(ref: number): void {
    this._stencilMaterial.stencilRef = ref;
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.mesh.geometry.dispose();
    this._stencilMaterial.dispose();
  }
}
