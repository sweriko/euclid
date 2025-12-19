import * as THREE from "three";
import { MeshStandardNodeMaterial, MeshBasicNodeMaterial } from "three/webgpu";
import { positionWorld, float, vec3, Fn, If, Discard } from "three/tsl";

/**
 * Creates a material that clips geometry on one side of a plane.
 * Used for objects that straddle a portal - they need to be clipped
 * at the portal plane when rendered in each world.
 */
export interface ClipPlaneParams {
  /** Normal vector pointing toward the kept geometry */
  normal: THREE.Vector3;
  /** A point on the clipping plane */
  point: THREE.Vector3;
}

/**
 * Create a clipped version of a MeshStandardNodeMaterial.
 * The material will discard fragments on one side of the clip plane.
 */
export function createClippedStandardMaterial(
  baseMaterial: MeshStandardNodeMaterial,
  clipPlane: ClipPlaneParams
): MeshStandardNodeMaterial {
  const material = baseMaterial.clone();

  // Calculate plane constant: d = -dot(normal, point)
  const planeConstant = -clipPlane.normal.dot(clipPlane.point);

  // Create shader node that clips based on signed distance to plane
  const clipNormal = vec3(
    clipPlane.normal.x,
    clipPlane.normal.y,
    clipPlane.normal.z
  );
  const clipConstant = float(planeConstant);

  // Override the color node to include clipping
  const originalColor = material.colorNode;
  material.colorNode = Fn(() => {
    // Calculate signed distance: dot(position, normal) + constant
    const signedDist = positionWorld.dot(clipNormal).add(clipConstant);

    // Discard if on wrong side of plane
    If(signedDist.lessThan(0), () => {
      Discard();
    });

    return originalColor;
  })();

  return material;
}

/**
 * Create a clipped version of a MeshBasicNodeMaterial.
 */
export function createClippedBasicMaterial(
  baseMaterial: MeshBasicNodeMaterial,
  clipPlane: ClipPlaneParams
): MeshBasicNodeMaterial {
  const material = baseMaterial.clone();

  const planeConstant = -clipPlane.normal.dot(clipPlane.point);
  const clipNormal = vec3(
    clipPlane.normal.x,
    clipPlane.normal.y,
    clipPlane.normal.z
  );
  const clipConstant = float(planeConstant);

  const originalColor = material.colorNode;
  material.colorNode = Fn(() => {
    const signedDist = positionWorld.dot(clipNormal).add(clipConstant);

    If(signedDist.lessThan(0), () => {
      Discard();
    });

    return originalColor;
  })();

  return material;
}

/**
 * Helper class for managing an object that can cross through portals.
 * Creates clipped versions of the object for rendering in each world.
 */
export class PortalCrossingObject {
  /** The original mesh */
  public readonly mesh: THREE.Mesh;

  /** Clone for the destination world (with opposite clipping) */
  public readonly clone: THREE.Mesh;

  /** Original material (unclipped) */
  private _originalMaterial: THREE.Material;

  /** Material clipped for the source world side */
  private _sourceClipMaterial: THREE.Material | null = null;

  /** Material clipped for the destination world side */
  private _destClipMaterial: THREE.Material | null = null;

  /** Current portal being crossed (if any) */
  private _crossingPortal: {
    normal: THREE.Vector3;
    point: THREE.Vector3;
  } | null = null;

  constructor(mesh: THREE.Mesh) {
    this.mesh = mesh;
    this._originalMaterial = mesh.material as THREE.Material;

    // Create a clone for the other world
    this.clone = mesh.clone();
    this.clone.visible = false;
  }

  /**
   * Update the crossing state based on position relative to a portal plane
   */
  updateCrossing(
    portalNormal: THREE.Vector3,
    portalPoint: THREE.Vector3,
    objectRadius: number
  ): boolean {
    const toObject = this.mesh.position.clone().sub(portalPoint);
    const signedDist = toObject.dot(portalNormal);

    const isCrossing = Math.abs(signedDist) < objectRadius;

    if (isCrossing) {
      // Object is crossing - set up clipping
      if (
        !this._crossingPortal ||
        !portalNormal.equals(this._crossingPortal.normal) ||
        !portalPoint.equals(this._crossingPortal.point)
      ) {
        this._crossingPortal = {
          normal: portalNormal.clone(),
          point: portalPoint.clone(),
        };
        this._updateClipMaterials();
      }

      // Apply clipped materials
      this.mesh.material = this._sourceClipMaterial!;
      this.clone.material = this._destClipMaterial!;
      this.clone.visible = true;
    } else {
      // Not crossing - use original material
      this.mesh.material = this._originalMaterial;
      this.clone.visible = false;
      this._crossingPortal = null;
    }

    return isCrossing;
  }

  /**
   * Sync clone position through portal transformation
   */
  syncClonePosition(
    sourcePortalPos: THREE.Vector3,
    sourcePortalQuat: THREE.Quaternion,
    destPortalPos: THREE.Vector3,
    destPortalQuat: THREE.Quaternion
  ): void {
    if (!this.clone.visible) return;

    // Transform position through portal
    const relativePos = this.mesh.position.clone().sub(sourcePortalPos);
    const srcInverse = sourcePortalQuat.clone().invert();
    relativePos.applyQuaternion(srcInverse);

    // Flip through portal
    relativePos.x = -relativePos.x;
    relativePos.z = -relativePos.z;

    relativePos.applyQuaternion(destPortalQuat);
    this.clone.position.copy(relativePos.add(destPortalPos));

    // Transform rotation
    const flipY = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI
    );
    this.clone.quaternion
      .copy(destPortalQuat)
      .multiply(flipY)
      .multiply(srcInverse)
      .multiply(this.mesh.quaternion);
  }

  private _updateClipMaterials(): void {
    if (!this._crossingPortal) return;

    const { normal, point } = this._crossingPortal;

    // Dispose old materials
    if (this._sourceClipMaterial) {
      this._sourceClipMaterial.dispose();
    }
    if (this._destClipMaterial) {
      this._destClipMaterial.dispose();
    }

    // Create new clipped materials
    if (this._originalMaterial instanceof MeshStandardNodeMaterial) {
      this._sourceClipMaterial = createClippedStandardMaterial(
        this._originalMaterial,
        { normal, point }
      );

      // Destination uses inverted normal
      this._destClipMaterial = createClippedStandardMaterial(
        this._originalMaterial,
        { normal: normal.clone().negate(), point }
      );
    } else {
      // Fallback: use original material
      this._sourceClipMaterial = this._originalMaterial.clone();
      this._destClipMaterial = this._originalMaterial.clone();
    }
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    if (this._sourceClipMaterial) {
      this._sourceClipMaterial.dispose();
    }
    if (this._destClipMaterial) {
      this._destClipMaterial.dispose();
    }
  }
}
