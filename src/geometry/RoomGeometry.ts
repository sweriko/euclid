import * as THREE from 'three';

/**
 * Creates a box room geometry with walls facing inward and a door cutout
 */
export function createRoomWithDoor(
  width: number,
  height: number,
  depth: number,
  doorWidth: number,
  doorHeight: number,
  inward: boolean = true
): THREE.BufferGeometry {
  const geometries: THREE.BufferGeometry[] = [];
  
  const hw = width / 2;
  const hh = height / 2;
  const hd = depth / 2;
  const dhw = doorWidth / 2;
  
  // Floor
  const floor = new THREE.PlaneGeometry(width, depth);
  floor.rotateX(inward ? -Math.PI / 2 : Math.PI / 2);
  floor.translate(0, -hh, 0);
  geometries.push(floor);
  
  // Ceiling
  const ceiling = new THREE.PlaneGeometry(width, depth);
  ceiling.rotateX(inward ? Math.PI / 2 : -Math.PI / 2);
  ceiling.translate(0, hh, 0);
  geometries.push(ceiling);
  
  // Back wall (no door)
  const backWall = new THREE.PlaneGeometry(width, height);
  if (!inward) backWall.rotateY(Math.PI);
  backWall.translate(0, 0, -hd);
  geometries.push(backWall);
  
  // Left wall
  const leftWall = new THREE.PlaneGeometry(depth, height);
  leftWall.rotateY(inward ? Math.PI / 2 : -Math.PI / 2);
  leftWall.translate(-hw, 0, 0);
  geometries.push(leftWall);
  
  // Right wall
  const rightWall = new THREE.PlaneGeometry(depth, height);
  rightWall.rotateY(inward ? -Math.PI / 2 : Math.PI / 2);
  rightWall.translate(hw, 0, 0);
  geometries.push(rightWall);
  
  // Front wall with door cutout
  // We need to create the wall in pieces around the door
  // Door is centered at bottom of front wall
  
  // Left section of front wall
  const leftSection = new THREE.PlaneGeometry(hw - dhw, height);
  leftSection.rotateY(inward ? Math.PI : 0);
  leftSection.translate(-dhw - (hw - dhw) / 2, 0, hd);
  geometries.push(leftSection);
  
  // Right section of front wall
  const rightSection = new THREE.PlaneGeometry(hw - dhw, height);
  rightSection.rotateY(inward ? Math.PI : 0);
  rightSection.translate(dhw + (hw - dhw) / 2, 0, hd);
  geometries.push(rightSection);
  
  // Top section above door
  const topSection = new THREE.PlaneGeometry(doorWidth, height - doorHeight);
  topSection.rotateY(inward ? Math.PI : 0);
  topSection.translate(0, hh - (height - doorHeight) / 2, hd);
  geometries.push(topSection);
  
  // Merge all geometries
  const merged = THREE.BufferGeometryUtils.mergeGeometries(geometries);
  
  // Clean up
  geometries.forEach(g => g.dispose());
  
  return merged;
}

/**
 * Creates a simple door frame geometry
 */
export function createDoorFrame(
  doorWidth: number,
  doorHeight: number,
  frameThickness: number,
  frameDepth: number
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const hw = doorWidth / 2 + frameThickness;
  const hh = doorHeight / 2 + frameThickness / 2;
  
  // Outer rectangle
  shape.moveTo(-hw, -hh + frameThickness / 2);
  shape.lineTo(hw, -hh + frameThickness / 2);
  shape.lineTo(hw, hh);
  shape.lineTo(-hw, hh);
  shape.lineTo(-hw, -hh + frameThickness / 2);
  
  // Inner rectangle (hole)
  const hole = new THREE.Path();
  const ihw = doorWidth / 2;
  const ihh = doorHeight / 2;
  hole.moveTo(-ihw, -ihh);
  hole.lineTo(ihw, -ihh);
  hole.lineTo(ihw, ihh);
  hole.lineTo(-ihw, ihh);
  hole.lineTo(-ihw, -ihh);
  shape.holes.push(hole);
  
  const extrudeSettings = {
    depth: frameDepth,
    bevelEnabled: false,
  };
  
  const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
  geometry.translate(0, ihh, -frameDepth / 2);
  
  return geometry;
}

/**
 * Creates a portal plane (for stencil mask)
 */
export function createPortalPlane(width: number, height: number): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(width, height);
  geometry.translate(0, height / 2, 0);
  return geometry;
}















