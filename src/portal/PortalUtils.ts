import * as THREE from "three";

/**
 * Compute an oblique projection matrix that clips the near plane to a given plane.
 * This is essential for portal rendering - it ensures that geometry behind the
 * destination portal is properly clipped.
 *
 * Based on the technique described in "Oblique View Frustum Depth Projection and Clipping"
 * by Eric Lengyel (Terathon Software).
 *
 * @param camera The camera to modify
 * @param clipPlane The clipping plane in world space (normal points toward visible area)
 * @returns Modified projection matrix
 */
export function computeObliqueProjectionMatrix(
  camera: THREE.PerspectiveCamera,
  clipPlane: THREE.Plane
): THREE.Matrix4 {
  // Get the current projection matrix
  const projectionMatrix = camera.projectionMatrix.clone();

  // Transform clip plane to camera space
  const viewMatrix = camera.matrixWorldInverse;
  const clipPlaneCamera = clipPlane.clone().applyMatrix4(viewMatrix);

  // Extract the clip plane components
  const clipPlaneVec = new THREE.Vector4(
    clipPlaneCamera.normal.x,
    clipPlaneCamera.normal.y,
    clipPlaneCamera.normal.z,
    clipPlaneCamera.constant
  );

  // Calculate the clip-space corner point opposite the clipping plane
  // This ensures the near plane is correctly positioned
  const q = new THREE.Vector4();
  q.x =
    (Math.sign(clipPlaneVec.x) + projectionMatrix.elements[8]) /
    projectionMatrix.elements[0];
  q.y =
    (Math.sign(clipPlaneVec.y) + projectionMatrix.elements[9]) /
    projectionMatrix.elements[5];
  q.z = -1.0;
  q.w = (1.0 + projectionMatrix.elements[10]) / projectionMatrix.elements[14];

  // Calculate the scaled clip plane vector
  const c = clipPlaneVec.multiplyScalar(2.0 / clipPlaneVec.dot(q));

  // Replace the third row of the projection matrix
  projectionMatrix.elements[2] = c.x;
  projectionMatrix.elements[6] = c.y;
  projectionMatrix.elements[10] = c.z + 1.0;
  projectionMatrix.elements[14] = c.w;

  return projectionMatrix;
}

/**
 * Transform a point through a portal (from one portal to its linked portal)
 *
 * @param point The point to transform
 * @param sourcePortal The source portal
 * @param destPortal The destination portal
 * @returns Transformed point
 */
export function transformPointThroughPortal(
  point: THREE.Vector3,
  sourcePortal: { position: THREE.Vector3; quaternion: THREE.Quaternion },
  destPortal: { position: THREE.Vector3; quaternion: THREE.Quaternion }
): THREE.Vector3 {
  // Get point relative to source portal
  const relativePos = point.clone().sub(sourcePortal.position);

  // Transform to source portal's local space
  const srcInverse = sourcePortal.quaternion.clone().invert();
  relativePos.applyQuaternion(srcInverse);

  // Rotate 180° (portals face each other)
  relativePos.x = -relativePos.x;
  relativePos.z = -relativePos.z;

  // Transform to destination portal's world space
  relativePos.applyQuaternion(destPortal.quaternion);

  // Add destination position
  return relativePos.add(destPortal.position);
}

/**
 * Transform a direction through a portal
 *
 * @param direction The direction to transform
 * @param sourcePortal The source portal
 * @param destPortal The destination portal
 * @returns Transformed direction
 */
export function transformDirectionThroughPortal(
  direction: THREE.Vector3,
  sourcePortal: { quaternion: THREE.Quaternion },
  destPortal: { quaternion: THREE.Quaternion }
): THREE.Vector3 {
  const result = direction.clone();

  // Transform to source portal's local space
  const srcInverse = sourcePortal.quaternion.clone().invert();
  result.applyQuaternion(srcInverse);

  // Rotate 180°
  result.x = -result.x;
  result.z = -result.z;

  // Transform to destination portal's world space
  result.applyQuaternion(destPortal.quaternion);

  return result;
}

/**
 * Transform a quaternion through a portal
 *
 * @param quat The quaternion to transform
 * @param sourcePortal The source portal
 * @param destPortal The destination portal
 * @returns Transformed quaternion
 */
export function transformQuaternionThroughPortal(
  quat: THREE.Quaternion,
  sourcePortal: { quaternion: THREE.Quaternion },
  destPortal: { quaternion: THREE.Quaternion }
): THREE.Quaternion {
  const srcInverse = sourcePortal.quaternion.clone().invert();
  const flipY = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.PI
  );

  return new THREE.Quaternion()
    .copy(destPortal.quaternion)
    .multiply(flipY)
    .multiply(srcInverse)
    .multiply(quat);
}

/**
 * Check if an object is crossing a portal (partially on both sides)
 *
 * @param objectPosition Object center position
 * @param objectRadius Object bounding radius
 * @param portalPlane Portal plane
 * @returns Object describing crossing state
 */
export function getPortalCrossingState(
  objectPosition: THREE.Vector3,
  objectRadius: number,
  portalPlane: THREE.Plane
): {
  crossing: boolean;
  signedDistance: number;
  inFront: number;
  behind: number;
} {
  const signedDistance = portalPlane.distanceToPoint(objectPosition);
  const inFront = Math.max(0, signedDistance + objectRadius);
  const behind = Math.max(0, -signedDistance + objectRadius);
  const crossing =
    signedDistance > -objectRadius && signedDistance < objectRadius;

  return { crossing, signedDistance, inFront, behind };
}

/**
 * Create a clipping shader node for TSL materials.
 * This clips geometry on one side of a plane.
 *
 * @param planeNormal Plane normal (points toward kept geometry)
 * @param planePoint Point on the plane
 * @returns Shader code string for the clip check
 */
export function createClipPlaneCheck(
  planeNormal: THREE.Vector3,
  planePoint: THREE.Vector3
): { normal: THREE.Vector3; constant: number } {
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
    planeNormal,
    planePoint
  );
  return { normal: plane.normal.clone(), constant: plane.constant };
}

/**
 * Generate a transformation matrix for teleporting through a portal
 *
 * @param sourcePortal Source portal transform
 * @param destPortal Destination portal transform
 * @returns 4x4 transformation matrix
 */
export function getPortalTeleportMatrix(
  sourcePortal: { position: THREE.Vector3; quaternion: THREE.Quaternion },
  destPortal: { position: THREE.Vector3; quaternion: THREE.Quaternion }
): THREE.Matrix4 {
  // Create matrices for the transformation chain:
  // 1. Move to source portal origin
  // 2. Rotate to source portal local space
  // 3. Flip 180° (portal passage)
  // 4. Rotate to destination portal space
  // 5. Move to destination portal position

  const srcInverse = sourcePortal.quaternion.clone().invert();
  const flipY = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.PI
  );

  const result = new THREE.Matrix4();

  // Build transformation: dest * flip * srcInverse * (-srcPos) + destPos
  const rotationQuat = new THREE.Quaternion()
    .copy(destPortal.quaternion)
    .multiply(flipY)
    .multiply(srcInverse);

  result.compose(
    new THREE.Vector3(), // Position handled separately
    rotationQuat,
    new THREE.Vector3(1, 1, 1)
  );

  return result;
}

/**
 * Calculate the screen-space bounds of a portal for potential optimizations
 * (scissor testing, etc.)
 *
 * @param portal Portal corners in world space
 * @param camera Camera to project with
 * @param screenWidth Screen width
 * @param screenHeight Screen height
 * @returns Screen-space bounding box or null if portal is behind camera
 */
export function getPortalScreenBounds(
  portalCorners: THREE.Vector3[],
  camera: THREE.Camera,
  screenWidth: number,
  screenHeight: number
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let allBehind = true;

  const tempVec = new THREE.Vector3();

  for (const corner of portalCorners) {
    tempVec.copy(corner).project(camera);

    // Check if point is in front of camera
    if (tempVec.z < 1) {
      allBehind = false;

      const screenX = (tempVec.x * 0.5 + 0.5) * screenWidth;
      const screenY = (1 - (tempVec.y * 0.5 + 0.5)) * screenHeight;

      minX = Math.min(minX, screenX);
      minY = Math.min(minY, screenY);
      maxX = Math.max(maxX, screenX);
      maxY = Math.max(maxY, screenY);
    }
  }

  if (allBehind) return null;

  // Clamp to screen bounds
  minX = Math.max(0, Math.min(screenWidth, minX));
  minY = Math.max(0, Math.min(screenHeight, minY));
  maxX = Math.max(0, Math.min(screenWidth, maxX));
  maxY = Math.max(0, Math.min(screenHeight, maxY));

  return { minX, minY, maxX, maxY };
}

/**
 * Get the four corners of a portal in world space
 */
export function getPortalCorners(
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
  width: number,
  height: number
): THREE.Vector3[] {
  const hw = width / 2;

  const corners = [
    new THREE.Vector3(-hw, 0, 0), // Bottom left
    new THREE.Vector3(hw, 0, 0), // Bottom right
    new THREE.Vector3(hw, height, 0), // Top right
    new THREE.Vector3(-hw, height, 0), // Top left
  ];

  for (const corner of corners) {
    corner.applyQuaternion(quaternion);
    corner.add(position);
  }

  return corners;
}
