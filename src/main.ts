import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { 
  WebGPURenderer,
  MeshStandardNodeMaterial,
  MeshBasicNodeMaterial,
  RenderTarget,
} from 'three/webgpu';
import { 
  color,
  normalWorld,
  float,
  vec3,
  mix,
  smoothstep,
  sin,
  time,
  texture,
  screenUV,
  positionWorld,
  Fn,
  If,
  Discard,
} from 'three/tsl';
import RAPIER from '@dimforge/rapier3d-compat';
import { FPSController, RoomBounds } from './character/FPSController';
import { resizeRendererToDisplaySize } from './helpers/responsiveness';

// ============================================
// CONSTANTS
// ============================================
const DOOR_WIDTH = 0.9;
const DOOR_HEIGHT = 1.6;
const OUTER_DOOR_FRAME_THICKNESS = 0.12;
const OUTER_DOOR_FRAME_DEPTH = 0.2;
// Inner room: 6m wide, 10m deep, 6m tall
const INNER_ROOM_WIDTH = 6;
const INNER_ROOM_DEPTH = 10;
const INNER_ROOM_HEIGHT = 6;
const GROUND_SIZE = 50;
let portalRenderWidth = 1024;
let portalRenderHeight = 1024;


// Portal positions (z coordinate of the door plane)
const OUTER_PORTAL_Z = 0.6;
const INNER_PORTAL_Z = INNER_ROOM_DEPTH / 2;

// Separate the inner world to avoid overlap (like Godot demo at z=48)
const INNER_WORLD_OFFSET = 100;

// Room bounds for collision (inner room - player is inside)
// Door is same size on both sides (small door in big room)
// Note: bounds are in world space with INNER_WORLD_OFFSET applied
const INNER_ROOM_BOUNDS: RoomBounds = {
  minX: -INNER_ROOM_WIDTH / 2,
  maxX: INNER_ROOM_WIDTH / 2,
  minY: 0,
  maxY: INNER_ROOM_HEIGHT,
  minZ: INNER_WORLD_OFFSET - INNER_ROOM_DEPTH / 2,
  maxZ: INNER_WORLD_OFFSET + INNER_ROOM_DEPTH / 2,
  doorMinX: -DOOR_WIDTH / 2,
  doorMaxX: DOOR_WIDTH / 2,
  doorMaxY: DOOR_HEIGHT,
  doorZ: INNER_WORLD_OFFSET + INNER_PORTAL_Z,
};

// ============================================
// GLOBALS
// ============================================
let renderer: WebGPURenderer;
let outerScene: THREE.Scene;
let innerScene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let portalCamera: THREE.PerspectiveCamera;
let physicsWorld: RAPIER.World;
let controller: FPSController;
let portalRenderTarget: RenderTarget;
let portalMesh: THREE.Mesh;
let portalMaterial: MeshBasicNodeMaterial;
let portalDebugOutline: THREE.LineSegments;
let innerSphere: THREE.Mesh;
let outerSphere: THREE.Mesh;
let stats: Stats;

// Pushable cube
let pushCubeBody: RAPIER.RigidBody;
let pushCubeMeshOuter: THREE.Mesh;
let pushCubeMeshInner: THREE.Mesh;
let pushCubeInInnerWorld = false;
const PUSH_CUBE_SIZE = 0.3;

// Debug settings
const DEBUG_PORTAL_OUTLINE = false;

// Track which world the player is in
let isInInnerRoom = false;
let lastPortalSide = 1; // 1 = outside portal, -1 = inside portal
let sphereDistFromPortal = 0; // For controlling sphere visibility

const inputState = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  jump: false,
  sprint: false,
};

let isPointerLocked = false;
let pendingMouseX = 0;
let pendingMouseY = 0;

// ============================================
// CREATE MATERIALS WITH TSL
// ============================================
function createOuterRoomMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  
  const worldPos = positionWorld;
  const noiseScale = float(0.5);
  const variation = sin(worldPos.x.mul(noiseScale)).mul(sin(worldPos.y.mul(noiseScale))).mul(sin(worldPos.z.mul(noiseScale)));
  
  const baseColor = color(0x6a6a6a);
  const accentColor = color(0x7a7a7a);
  
  material.colorNode = mix(baseColor, accentColor, variation.mul(0.5).add(0.5));
  material.roughnessNode = float(0.85);
  material.metalnessNode = float(0.1);
  material.side = THREE.DoubleSide;
  
  return material;
}

function createInnerRoomMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  
  const nrm = normalWorld;
  
  const floorColor = color(0x2d1f1a);
  const wallColor = color(0xd4c4b0);
  const ceilingColor = color(0xf5f0e8);
  
  const upFactor = smoothstep(float(0.7), float(1.0), nrm.y);
  const downFactor = smoothstep(float(-1.0), float(-0.7), nrm.y.negate());
  
  let finalColor = mix(wallColor, ceilingColor, upFactor);
  finalColor = mix(finalColor, floorColor, downFactor);
  
  material.colorNode = finalColor;
  material.roughnessNode = float(0.6);
  material.metalnessNode = float(0.05);
  material.side = THREE.DoubleSide;
  
  // Prevent z-fighting with door frames
  material.polygonOffset = true;
  material.polygonOffsetFactor = 1;
  material.polygonOffsetUnits = 1;
  
  return material;
}

function createGroundMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  
  const worldPos = positionWorld;
  const scale1 = float(0.3);
  const scale2 = float(0.39);
  const variation = sin(worldPos.x.mul(scale1).add(worldPos.z.mul(scale2))).mul(0.1).add(0.9);
  
  const grassColor = color(0x3d5c3d);
  
  material.colorNode = grassColor.mul(variation);
  material.roughnessNode = float(0.9);
  material.metalnessNode = float(0.0);
  
  // Prevent z-fighting with door frames and other geometry at floor level
  material.polygonOffset = true;
  material.polygonOffsetFactor = 1;
  material.polygonOffsetUnits = 1;
  
  return material;
}

function createPortalMaterial(renderTarget: RenderTarget): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  // Use screen UV so the portal acts like a window - texture is sampled based on screen position
  material.colorNode = texture(renderTarget.texture, screenUV);
  // Only render the portal from the "front" side so you can't see through it from behind
  material.side = THREE.FrontSide;
  return material;
}

// ============================================
// CREATE ROOM GEOMETRIES
// ============================================
function createRoomWithDoorGeometry(
  width: number,
  height: number,
  depth: number,
  doorWidth: number,
  doorHeight: number
): THREE.BufferGeometry {
  const geometries: THREE.BufferGeometry[] = [];
  
  const hw = width / 2;
  const hh = height / 2;
  const hd = depth / 2;
  const dhw = doorWidth / 2;
  
  // Floor
  const floor = new THREE.PlaneGeometry(width, depth);
  floor.rotateX(-Math.PI / 2);
  floor.translate(0, -hh, 0);
  geometries.push(floor);
  
  // Ceiling
  const ceiling = new THREE.PlaneGeometry(width, depth);
  ceiling.rotateX(Math.PI / 2);
  ceiling.translate(0, hh, 0);
  geometries.push(ceiling);
  
  // Back wall
  const backWall = new THREE.PlaneGeometry(width, height);
  backWall.translate(0, 0, -hd);
  geometries.push(backWall);
  
  // Left wall
  const leftWall = new THREE.PlaneGeometry(depth, height);
  leftWall.rotateY(Math.PI / 2);
  leftWall.translate(-hw, 0, 0);
  geometries.push(leftWall);
  
  // Right wall
  const rightWall = new THREE.PlaneGeometry(depth, height);
  rightWall.rotateY(-Math.PI / 2);
  rightWall.translate(hw, 0, 0);
  geometries.push(rightWall);
  
  // Front wall sections (around door)
  const sideWidth = hw - dhw;
  if (sideWidth > 0.01) {
    const leftSection = new THREE.PlaneGeometry(sideWidth, height);
    leftSection.rotateY(Math.PI);
    leftSection.translate(-dhw - sideWidth / 2, 0, hd);
    geometries.push(leftSection);
    
    const rightSection = new THREE.PlaneGeometry(sideWidth, height);
    rightSection.rotateY(Math.PI);
    rightSection.translate(dhw + sideWidth / 2, 0, hd);
    geometries.push(rightSection);
  }
  
  // Top section above door
  const topHeight = height - doorHeight;
  if (topHeight > 0.01) {
    const topSection = new THREE.PlaneGeometry(doorWidth, topHeight);
    topSection.rotateY(Math.PI);
    topSection.translate(0, hh - topHeight / 2, hd);
    geometries.push(topSection);
  }
  
  const merged = mergeGeometries(geometries);
  geometries.forEach(g => g.dispose());
  
  return merged;
}

function createDoorFrameGeometry(
  doorWidth: number,
  doorHeight: number,
  frameThickness: number,
  frameDepth: number
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const postHeight = doorHeight + frameThickness;
  
  const leftPost = new THREE.BoxGeometry(frameThickness, postHeight, frameDepth);
  leftPost.translate(-doorWidth / 2 - frameThickness / 2, postHeight / 2, 0);
  parts.push(leftPost);
  
  const rightPost = new THREE.BoxGeometry(frameThickness, postHeight, frameDepth);
  rightPost.translate(doorWidth / 2 + frameThickness / 2, postHeight / 2, 0);
  parts.push(rightPost);
  
  const topBeam = new THREE.BoxGeometry(doorWidth + frameThickness * 2, frameThickness, frameDepth);
  topBeam.translate(0, doorHeight + frameThickness / 2, 0);
  parts.push(topBeam);
  
  const merged = mergeGeometries(parts);
  parts.forEach(p => p.dispose());
  
  return merged;
}

// ============================================
// CREATE SCENE OBJECTS
// ============================================
function createOuterWorld(): THREE.Group {
  const group = new THREE.Group();
  
  // Ground
  const groundGeometry = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE);
  groundGeometry.rotateX(-Math.PI / 2);
  const groundMaterial = createGroundMaterial();
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  group.add(ground);
  
  // Outer portal frame (no outer "room" box)
  const frameGeometry = createDoorFrameGeometry(
    DOOR_WIDTH,
    DOOR_HEIGHT,
    OUTER_DOOR_FRAME_THICKNESS,
    OUTER_DOOR_FRAME_DEPTH
  );
  const frameMaterial = createOuterRoomMaterial();
  const frameMesh = new THREE.Mesh(frameGeometry, frameMaterial);
  frameMesh.position.set(0, 0, OUTER_PORTAL_Z);
  group.add(frameMesh);
  
  return group;
}

function createInnerWorld(): THREE.Group {
  const group = new THREE.Group();
  
  // Inner room - same small door as outside (non-Euclidean!)
  const roomGeometry = createRoomWithDoorGeometry(
    INNER_ROOM_WIDTH,
    INNER_ROOM_HEIGHT,
    INNER_ROOM_DEPTH,
    DOOR_WIDTH,   // Same door size as outside
    DOOR_HEIGHT
  );
  const roomMaterial = createInnerRoomMaterial();
  const roomMesh = new THREE.Mesh(roomGeometry, roomMaterial);
  roomMesh.position.set(0, INNER_ROOM_HEIGHT / 2, 0);
  group.add(roomMesh);
  
  // Interior objects
  addInteriorObjects(group);
  
  return group;
}

function addInteriorObjects(group: THREE.Group): void {
  // Columns for 6x10x6 room
  const columnGeometry = new THREE.CylinderGeometry(0.2, 0.25, INNER_ROOM_HEIGHT - 0.2, 16);
  const columnMaterial = new MeshStandardNodeMaterial();
  columnMaterial.colorNode = color(0xc9b896);
  columnMaterial.roughnessNode = float(0.5);
  columnMaterial.metalnessNode = float(0.1);
  
  const columnPositions = [
    [-2.4, INNER_ROOM_HEIGHT / 2 - 0.1, -3],
    [2.4, INNER_ROOM_HEIGHT / 2 - 0.1, -3],
    [-2.4, INNER_ROOM_HEIGHT / 2 - 0.1, 1],
    [2.4, INNER_ROOM_HEIGHT / 2 - 0.1, 1],
  ];
  
  columnPositions.forEach(pos => {
    const column = new THREE.Mesh(columnGeometry, columnMaterial);
    column.position.set(pos[0], pos[1], pos[2]);
    group.add(column);
  });
  
  // Animated sphere - flies back and forth
  const sphereGeometry = new THREE.SphereGeometry(0.4, 32, 32);
  const sphereMaterial = new MeshStandardNodeMaterial();
  const hueShift = sin(time.mul(0.5)).mul(0.1).add(0.55);
  sphereMaterial.colorNode = vec3(hueShift, float(0.3), float(0.7));
  sphereMaterial.roughnessNode = float(0.2);
  sphereMaterial.metalnessNode = float(0.8);
  sphereMaterial.emissiveNode = vec3(hueShift.mul(0.2), float(0.05), float(0.1));
  
  innerSphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
  innerSphere.position.set(0, 2.5, -2);
  group.add(innerSphere);
  
  // Furniture - larger tables/pedestals
  const cubeGeometry = new THREE.BoxGeometry(1.2, 0.8, 1.2);
  const cubeMaterial = new MeshStandardNodeMaterial();
  cubeMaterial.colorNode = color(0x5c4033);
  cubeMaterial.roughnessNode = float(0.7);
  
  const cubePositions = [
    [-2, 0.4, -4],
    [2, 0.4, -4],
    [0, 0.4, -4],
  ];
  
  cubePositions.forEach(pos => {
    const cube = new THREE.Mesh(cubeGeometry, cubeMaterial);
    cube.position.set(pos[0], pos[1], pos[2]);
    group.add(cube);
  });
}

function createPortalPlane(renderTarget: RenderTarget, width: number, height: number): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(width, height);
  geometry.translate(0, height / 2, 0);
  
  portalMaterial = createPortalMaterial(renderTarget);
  
  const mesh = new THREE.Mesh(geometry, portalMaterial);
  return mesh;
}

function createPortalDebugOutline(width: number, height: number): THREE.LineSegments {
  const hw = width / 2;
  
  const v0 = new THREE.Vector3(-hw, 0, 0);
  const v1 = new THREE.Vector3(hw, 0, 0);
  const v2 = new THREE.Vector3(hw, height, 0);
  const v3 = new THREE.Vector3(-hw, height, 0);
  
  const points = [
    v0, v1,
    v1, v2,
    v2, v3,
    v3, v0,
    v0, v2,
  ];
  
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  
  const material = new THREE.LineBasicMaterial({
    color: 0x00ff00,
    linewidth: 2,
    depthTest: false,
    transparent: true,
    opacity: 0.8,
  });
  
  const lines = new THREE.LineSegments(geometry, material);
  lines.renderOrder = 999;
  
  return lines;
}

function createLighting(scene: THREE.Scene, isInner: boolean): void {
  const ambient = new THREE.AmbientLight(isInner ? 0x505050 : 0x606070, isInner ? 0.5 : 0.6);
  scene.add(ambient);
  
  if (isInner) {
    const roomCenterZ = INNER_WORLD_OFFSET;
    
    const centerLight = new THREE.PointLight(0xffeedd, 300, 25);
    centerLight.position.set(0, INNER_ROOM_HEIGHT - 0.5, roomCenterZ);
    scene.add(centerLight);
    
    const fillLight1 = new THREE.PointLight(0xaaccff, 150, 15);
    fillLight1.position.set(2, 3, roomCenterZ + 3);
    scene.add(fillLight1);
    
    const fillLight2 = new THREE.PointLight(0xffccaa, 150, 15);
    fillLight2.position.set(-2, 3, roomCenterZ - 3);
    scene.add(fillLight2);
  } else {
    const directional = new THREE.DirectionalLight(0xfff5e6, 1.5);
    directional.position.set(10, 20, 10);
    scene.add(directional);
  }
}

// ============================================
// PHYSICS SETUP
// ============================================
function setupPhysics(): void {
  // Ground
  const groundBody = physicsWorld.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0)
  );
  physicsWorld.createCollider(
    RAPIER.ColliderDesc.cuboid(GROUND_SIZE / 2, 0.5, GROUND_SIZE / 2).setFriction(0.8),
    groundBody
  );
  
  // Create outer doorframe collision
  createOuterDoorFrameCollision();
  
  // Create inner room collision
  createInnerRoomCollision();
  
  controller = new FPSController(
    physicsWorld,
    new THREE.Vector3(0, 1, 5),
    {
      walkSpeed: 4,
      sprintSpeed: 7,
      strafeSpeed: 3,
      backwardSpeed: 2.5,
      jumpSpeed: 6,
      mouseSensitivity: 0.002,
      gravity: 18,
      playerHeight: 0.6,
      playerRadius: 0.2,
    }
  );
  
  controller.setBounds(null);
  
  // Create pushable cube
  createPushableCube();
}

function createPushableCube(): void {
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(1.5, PUSH_CUBE_SIZE / 2 + 0.01, 1.5);
  pushCubeBody = physicsWorld.createRigidBody(bodyDesc);
  
  const colliderDesc = RAPIER.ColliderDesc.cuboid(
    PUSH_CUBE_SIZE / 2,
    PUSH_CUBE_SIZE / 2,
    PUSH_CUBE_SIZE / 2
  ).setFriction(0.8).setRestitution(0.05).setMass(1);
  
  physicsWorld.createCollider(colliderDesc, pushCubeBody);
}

function updatePushableCube(): void {
  if (!pushCubeBody || !pushCubeMeshOuter) return;
  
  const pos = pushCubeBody.translation();
  const rot = pushCubeBody.rotation();
  
  // Push cube if player is close
  const playerPos = controller.position;
  const playerRadius = controller.options.playerRadius;
  const playerHalfHeight = controller.options.playerHeight / 2 + playerRadius;
  const pushRadius = PUSH_CUBE_SIZE / 2 + playerRadius + 0.25;
  
  const cubeInSameWorld = (pushCubeInInnerWorld === isInInnerRoom);
  
  if (cubeInSameWorld) {
    const dx = pos.x - playerPos.x;
    const dz = pos.z - playerPos.z;
    const distHorizontal = Math.sqrt(dx * dx + dz * dz);
    const cubeBottom = pos.y - PUSH_CUBE_SIZE / 2;
    const cubeTop = pos.y + PUSH_CUBE_SIZE / 2;
    const playerTop = playerPos.y + playerHalfHeight;
    const playerBottom = playerPos.y - playerHalfHeight;
    
    const verticalOverlap = playerBottom < cubeTop + 0.1 && playerTop > cubeBottom - 0.1;
    
    if (distHorizontal < pushRadius && verticalOverlap && distHorizontal > 0.01) {
      pushCubeBody.wakeUp();
      
      const overlap = pushRadius - distHorizontal;
      const pushDir = { x: dx / distHorizontal, z: dz / distHorizontal };
      const pushSpeed = Math.min(overlap * 8.0, 2.5);
      
      const curVel = pushCubeBody.linvel();
      pushCubeBody.setLinvel({
        x: pushDir.x * pushSpeed,
        y: curVel.y,
        z: pushDir.z * pushSpeed,
      }, true);
    }
  }
  
  // Check if cube should teleport through portal
  const portalZ = pushCubeInInnerWorld 
    ? INNER_WORLD_OFFSET + INNER_PORTAL_Z 
    : OUTER_PORTAL_Z;
  const doorHalfWidth = DOOR_WIDTH / 2;
  const cubeHalf = PUSH_CUBE_SIZE / 2;
  
  const inDoorX = Math.abs(pos.x) < doorHalfWidth;
  const inDoorY = pos.y > 0 && pos.y < DOOR_HEIGHT;
  
  if (!pushCubeInInnerWorld) {
    const inFrontOfRoom = pos.z > 0;
    const crossingPortal = pos.z < portalZ && pos.z > portalZ - cubeHalf - 0.1;
    
    if (inDoorX && inDoorY && inFrontOfRoom && crossingPortal) {
      teleportCubeToInner();
    }
  } else {
    const innerPortalZ = INNER_WORLD_OFFSET + INNER_PORTAL_Z;
    const crossingPortal = pos.z > innerPortalZ && pos.z < innerPortalZ + cubeHalf + 0.1;
    
    if (inDoorX && inDoorY && crossingPortal) {
      teleportCubeToOuter();
    }
  }
  
  // Calculate distance from portal for positioning both meshes
  const cubeHalfSize = PUSH_CUBE_SIZE / 2;
  let distFromPortal: number;
  
  if (pushCubeInInnerWorld) {
    distFromPortal = pos.z - (INNER_WORLD_OFFSET + INNER_PORTAL_Z);
  } else {
    distFromPortal = pos.z - OUTER_PORTAL_Z;
  }
  
  const cubeInDoorArea = Math.abs(pos.x) < DOOR_WIDTH / 2 + cubeHalfSize && 
                         pos.y < DOOR_HEIGHT + cubeHalfSize;
  const nearPortalZ = Math.abs(distFromPortal) < cubeHalfSize + 0.5;
  const usePortalVisuals = cubeInDoorArea && nearPortalZ;
  
  if (usePortalVisuals) {
    pushCubeMeshOuter.position.set(pos.x, pos.y, OUTER_PORTAL_Z + distFromPortal);
    pushCubeMeshOuter.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    
    pushCubeMeshInner.position.set(pos.x, pos.y, INNER_WORLD_OFFSET + INNER_PORTAL_Z + distFromPortal);
    pushCubeMeshInner.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    
    const hasOutsidePart = distFromPortal > -cubeHalfSize;
    const hasInsidePart = distFromPortal < cubeHalfSize;
    
    pushCubeMeshOuter.visible = hasOutsidePart;
    pushCubeMeshInner.visible = hasInsidePart;
  } else {
    if (pushCubeInInnerWorld) {
      pushCubeMeshOuter.visible = false;
      pushCubeMeshInner.visible = true;
      pushCubeMeshInner.position.set(pos.x, pos.y, pos.z);
      pushCubeMeshInner.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    } else {
      pushCubeMeshOuter.visible = true;
      pushCubeMeshInner.visible = false;
      pushCubeMeshOuter.position.set(pos.x, pos.y, pos.z);
      pushCubeMeshOuter.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    }
  }
}

function teleportCubeToInner(): void {
  const pos = pushCubeBody.translation();
  const distFromPortal = pos.z - OUTER_PORTAL_Z;
  const newZ = INNER_WORLD_OFFSET + INNER_PORTAL_Z + distFromPortal;
  
  pushCubeBody.setTranslation({ x: pos.x, y: pos.y, z: newZ }, true);
  pushCubeInInnerWorld = true;
}

function teleportCubeToOuter(): void {
  const pos = pushCubeBody.translation();
  const innerPortalZ = INNER_WORLD_OFFSET + INNER_PORTAL_Z;
  const distFromPortal = pos.z - innerPortalZ;
  const newZ = OUTER_PORTAL_Z + distFromPortal;
  
  pushCubeBody.setTranslation({ x: pos.x, y: pos.y, z: newZ }, true);
  pushCubeInInnerWorld = false;
}

function createOuterDoorFrameCollision(): void {
  const t = OUTER_DOOR_FRAME_THICKNESS;
  const d = OUTER_DOOR_FRAME_DEPTH;
  
  const postHeight = DOOR_HEIGHT + t;
  const postY = postHeight / 2;
  const postZ = OUTER_PORTAL_Z;
  
  const addCollider = (hx: number, hy: number, hz: number, x: number, y: number, z: number) => {
    const body = physicsWorld.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z)
    );
    physicsWorld.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.5),
      body
    );
  };
  
  // Left post
  addCollider(
    t / 2,
    postHeight / 2,
    d / 2,
    -DOOR_WIDTH / 2 - t / 2,
    postY,
    postZ
  );
  
  // Right post
  addCollider(
    t / 2,
    postHeight / 2,
    d / 2,
    DOOR_WIDTH / 2 + t / 2,
    postY,
    postZ
  );
  
  // Top beam
  addCollider(
    (DOOR_WIDTH + t * 2) / 2,
    t / 2,
    d / 2,
    0,
    DOOR_HEIGHT + t / 2,
    postZ
  );
}

function createInnerRoomCollision(): void {
  const wallThickness = 0.15;
  const hw = INNER_ROOM_WIDTH / 2;
  const hh = INNER_ROOM_HEIGHT / 2;
  const hd = INNER_ROOM_DEPTH / 2;
  const doorHW = DOOR_WIDTH / 2;
  const doorH = DOOR_HEIGHT;
  const oz = INNER_WORLD_OFFSET;
  
  const addCollider = (hx: number, hy: number, hz: number, x: number, y: number, z: number, friction = 0.5) => {
    const body = physicsWorld.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z)
    );
    physicsWorld.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(friction),
      body
    );
  };
  
  // Floor
  addCollider(INNER_ROOM_WIDTH / 2, wallThickness / 2, INNER_ROOM_DEPTH / 2, 0, -wallThickness / 2, oz, 0.8);
  
  // Ceiling
  addCollider(INNER_ROOM_WIDTH / 2, wallThickness / 2, INNER_ROOM_DEPTH / 2, 0, INNER_ROOM_HEIGHT + wallThickness / 2, oz);
  
  // Back wall
  addCollider(INNER_ROOM_WIDTH / 2, INNER_ROOM_HEIGHT / 2, wallThickness / 2, 0, hh, oz - hd - wallThickness / 2);
  
  // Left wall
  addCollider(wallThickness / 2, INNER_ROOM_HEIGHT / 2, INNER_ROOM_DEPTH / 2, -hw - wallThickness / 2, hh, oz);
  
  // Right wall
  addCollider(wallThickness / 2, INNER_ROOM_HEIGHT / 2, INNER_ROOM_DEPTH / 2, hw + wallThickness / 2, hh, oz);
  
  // Front wall - sections around door
  const sideWidth = hw - doorHW;
  if (sideWidth > 0.05) {
    addCollider(sideWidth / 2, INNER_ROOM_HEIGHT / 2, wallThickness / 2, -doorHW - sideWidth / 2, hh, oz + hd + wallThickness / 2);
    addCollider(sideWidth / 2, INNER_ROOM_HEIGHT / 2, wallThickness / 2, doorHW + sideWidth / 2, hh, oz + hd + wallThickness / 2);
  }
  
  // Front wall - top section
  const topHeight = INNER_ROOM_HEIGHT - doorH;
  if (topHeight > 0.05) {
    addCollider(DOOR_WIDTH / 2, topHeight / 2, wallThickness / 2, 0, doorH + topHeight / 2, oz + hd + wallThickness / 2);
  }
}

// ============================================
// INPUT HANDLING
// ============================================
function setupInput(): void {
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  
  const canvas = document.getElementById('canvas')!;
  canvas.addEventListener('click', () => {
    if (!isPointerLocked) {
      canvas.requestPointerLock();
    }
  });
}

function onKeyDown(e: KeyboardEvent): void {
  switch (e.code) {
    case 'KeyW':
    case 'ArrowUp':
      inputState.forward = true;
      break;
    case 'KeyS':
    case 'ArrowDown':
      inputState.backward = true;
      break;
    case 'KeyA':
    case 'ArrowLeft':
      inputState.left = true;
      break;
    case 'KeyD':
    case 'ArrowRight':
      inputState.right = true;
      break;
    case 'Space':
      inputState.jump = true;
      break;
    case 'ShiftLeft':
    case 'ShiftRight':
      inputState.sprint = true;
      break;
  }
}

function onKeyUp(e: KeyboardEvent): void {
  switch (e.code) {
    case 'KeyW':
    case 'ArrowUp':
      inputState.forward = false;
      break;
    case 'KeyS':
    case 'ArrowDown':
      inputState.backward = false;
      break;
    case 'KeyA':
    case 'ArrowLeft':
      inputState.left = false;
      break;
    case 'KeyD':
    case 'ArrowRight':
      inputState.right = false;
      break;
    case 'Space':
      inputState.jump = false;
      break;
    case 'ShiftLeft':
    case 'ShiftRight':
      inputState.sprint = false;
      break;
  }
}

function onMouseMove(e: MouseEvent): void {
  if (isPointerLocked) {
    pendingMouseX += e.movementX;
    pendingMouseY += e.movementY;
  }
}

function onPointerLockChange(): void {
  isPointerLocked = document.pointerLockElement !== null;
}

// ============================================
// PORTAL LOGIC
// ============================================

function checkPortalTraversal(): void {
  const pos = controller.position;
  const portalZ = isInInnerRoom 
    ? INNER_WORLD_OFFSET + INNER_PORTAL_Z 
    : OUTER_PORTAL_Z;
  const doorHalfWidth = DOOR_WIDTH / 2;
  const doorHeight = DOOR_HEIGHT;
  
  const inDoorX = Math.abs(pos.x) < doorHalfWidth;
  const inDoorY = pos.y > 0 && pos.y < doorHeight + 0.5;
  const nearPortal = Math.abs(pos.z - portalZ) < 0.4;
  
  const currentSide = pos.z > portalZ ? 1 : -1;
  
  if (inDoorX && inDoorY && nearPortal) {
    if (currentSide !== lastPortalSide) {
      teleportThroughPortal();
    }
    lastPortalSide = currentSide;
  }
}

function teleportThroughPortal(): void {
  const pos = controller.position;
  
  const outerPortalZ = OUTER_PORTAL_Z;
  const innerPortalZ = INNER_WORLD_OFFSET + INNER_PORTAL_Z;
  
  if (isInInnerRoom) {
    const distFromPortal = pos.z - innerPortalZ;
    const newZ = outerPortalZ + distFromPortal;
    
    controller.teleport(new THREE.Vector3(pos.x, pos.y, newZ));
    controller.setBounds(null);
    isInInnerRoom = false;
    lastPortalSide = newZ > outerPortalZ ? 1 : -1;
  } else {
    const distFromPortal = pos.z - outerPortalZ;
    const newZ = innerPortalZ + distFromPortal;
    
    controller.teleport(new THREE.Vector3(pos.x, pos.y, newZ));
    controller.setBounds(INNER_ROOM_BOUNDS);
    isInInnerRoom = true;
    lastPortalSide = newZ > innerPortalZ ? 1 : -1;
  }
}

function updatePortalCamera(): void {
  const mainCamPos = camera.position.clone();
  
  const outerPortalZ = OUTER_PORTAL_Z;
  const innerPortalZ = INNER_WORLD_OFFSET + INNER_PORTAL_Z;
  
  const portalOffset = innerPortalZ - outerPortalZ;
  
  if (isInInnerRoom) {
    portalCamera.position.set(mainCamPos.x, mainCamPos.y, mainCamPos.z - portalOffset);
  } else {
    portalCamera.position.set(mainCamPos.x, mainCamPos.y, mainCamPos.z + portalOffset);
  }
  
  portalCamera.quaternion.copy(camera.quaternion);
  
  portalCamera.updateMatrixWorld(true);
  portalCamera.projectionMatrix.copy(camera.projectionMatrix);
}

function updatePortalMesh(): void {
  if (isInInnerRoom) {
    portalMesh.position.set(0, 0, INNER_WORLD_OFFSET + INNER_PORTAL_Z);
    portalMesh.rotation.set(0, Math.PI, 0);
  } else {
    portalMesh.position.set(0, 0, OUTER_PORTAL_Z);
    portalMesh.rotation.set(0, 0, 0);
  }
}

// ============================================
// MAIN LOOP
// ============================================
let previousTime = 0;

function update(currentTime: number): void {
  stats.begin();
  requestAnimationFrame(update);
  
  const deltaS = Math.min((currentTime - previousTime) / 1000, 0.033);
  previousTime = currentTime;
  
  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  if (resizeRendererToDisplaySize(renderer, pixelRatio)) {
    const width = renderer.domElement.clientWidth;
    const height = renderer.domElement.clientHeight;
    
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    portalCamera.aspect = camera.aspect;
    portalCamera.updateProjectionMatrix();
    
    if (width !== portalRenderWidth || height !== portalRenderHeight) {
      portalRenderWidth = width;
      portalRenderHeight = height;
      portalRenderTarget.setSize(width, height);
    }
  }
  
  // Update controller input
  const forwardInput = (inputState.forward ? 1 : 0) - (inputState.backward ? 1 : 0);
  const rightInput = (inputState.right ? 1 : 0) - (inputState.left ? 1 : 0);
  controller.setMoveInput(forwardInput, rightInput);
  controller.setSprinting(inputState.sprint);
  
  if (inputState.jump) {
    controller.jump();
  }
  
  // Apply mouse look
  controller.rotate(pendingMouseX, pendingMouseY);
  pendingMouseX = 0;
  pendingMouseY = 0;
  
  controller.update(deltaS);
  
  // Step physics world
  physicsWorld.step();
  
  // Sync player position from physics
  controller.syncFromPhysics();
  
  // Check portal traversal
  checkPortalTraversal();
  
  // Animate sphere through the portal
  if (innerSphere && outerSphere) {
    const t = currentTime * 0.001;
    
    const travelRange = 3;
    const cyclePos = Math.sin(t * 0.5) * travelRange - 1;
    
    const localY = DOOR_HEIGHT * 0.5;
    const localX = 0;
    
    sphereDistFromPortal = cyclePos;
    
    outerSphere.position.set(localX, localY, OUTER_PORTAL_Z + sphereDistFromPortal);
    innerSphere.position.set(localX, localY, INNER_PORTAL_Z + sphereDistFromPortal);
    
    innerSphere.visible = true;
  }
  
  // Update pushable cube
  updatePushableCube();
  
  // Update camera
  const camPos = controller.getCameraPosition();
  camera.position.copy(camPos);
  camera.quaternion.copy(controller.getCameraQuaternion());
  
  // Update portal
  updatePortalMesh();
  
  // Determine which scenes to render
  const currentScene = isInInnerRoom ? innerScene : outerScene;
  const portalScene = isInInnerRoom ? outerScene : innerScene;
  
  // Update portal mesh parent
  if (portalMesh.parent !== currentScene) {
    portalMesh.removeFromParent();
    currentScene.add(portalMesh);
    
    if (DEBUG_PORTAL_OUTLINE && portalDebugOutline) {
      portalDebugOutline.removeFromParent();
      currentScene.add(portalDebugOutline);
    }
  }
  
  // Update portal camera
  camera.updateMatrixWorld();
  updatePortalCamera();
  
  // Control outerSphere visibility per render pass
  const SPHERE_RADIUS = 0.4;
  const sphereHasOutsidePart = sphereDistFromPortal > -SPHERE_RADIUS;
  
  // Render portal view to texture
  if (outerSphere) {
    outerSphere.visible = isInInnerRoom;
  }
  renderer.setRenderTarget(portalRenderTarget);
  renderer.render(portalScene, portalCamera);
  
  // Render main scene
  if (outerSphere) {
    outerSphere.visible = !isInInnerRoom && sphereHasOutsidePart;
  }
  renderer.setRenderTarget(null);
  renderer.render(currentScene, camera);
  
  stats.end();
}

// ============================================
// INITIALIZATION
// ============================================
async function init(): Promise<void> {
  // Initialize Rapier
  await RAPIER.init();
  
  // Create physics world
  physicsWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  
  renderer = new WebGPURenderer({
    canvas,
    antialias: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.localClippingEnabled = true;
  
  await renderer.init();
  
  // Create render target for portal
  portalRenderWidth = window.innerWidth;
  portalRenderHeight = window.innerHeight;
  portalRenderTarget = new RenderTarget(portalRenderWidth, portalRenderHeight, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
  });
  
  // Outer scene
  outerScene = new THREE.Scene();
  outerScene.background = new THREE.Color(0x87ceeb);
  const outerWorld = createOuterWorld();
  outerScene.add(outerWorld);
  createLighting(outerScene, false);
  
  // Inner scene
  innerScene = new THREE.Scene();
  innerScene.background = new THREE.Color(0x1a1510);
  const innerWorld = createInnerWorld();
  innerWorld.position.z = INNER_WORLD_OFFSET;
  innerScene.add(innerWorld);
  createLighting(innerScene, true);
  
  // Cameras
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);
  portalCamera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);
  
  setupPhysics();
  
  // Create pushable cube visuals
  const pushCubeGeometry = new THREE.BoxGeometry(PUSH_CUBE_SIZE, PUSH_CUBE_SIZE, PUSH_CUBE_SIZE);
  const pushCubeMaterial = new MeshStandardNodeMaterial();
  pushCubeMaterial.colorNode = color(0xe07030);
  pushCubeMaterial.roughnessNode = float(0.4);
  pushCubeMaterial.metalnessNode = float(0.1);
  
  pushCubeMeshOuter = new THREE.Mesh(pushCubeGeometry, pushCubeMaterial);
  outerScene.add(pushCubeMeshOuter);
  
  pushCubeMeshInner = new THREE.Mesh(pushCubeGeometry, pushCubeMaterial.clone());
  innerScene.add(pushCubeMeshInner);
  
  // Portal plane
  portalMesh = createPortalPlane(portalRenderTarget, DOOR_WIDTH, DOOR_HEIGHT);
  portalMesh.position.set(0, 0, OUTER_PORTAL_Z - 0.005);
  outerScene.add(portalMesh);
  
  // Create outer sphere
  const outerSphereGeometry = new THREE.SphereGeometry(0.4, 32, 32);
  const outerSphereMaterial = new MeshStandardNodeMaterial();
  const hueShift2 = sin(time.mul(0.5)).mul(0.1).add(0.55);
  
  const clipZ = float(OUTER_PORTAL_Z);
  outerSphereMaterial.colorNode = Fn(() => {
    If(positionWorld.z.lessThan(clipZ), () => {
      Discard();
    });
    return vec3(hueShift2, float(0.3), float(0.7));
  })();
  outerSphereMaterial.roughnessNode = float(0.2);
  outerSphereMaterial.metalnessNode = float(0.8);
  outerSphereMaterial.emissiveNode = vec3(hueShift2.mul(0.2), float(0.05), float(0.1));
  outerSphere = new THREE.Mesh(outerSphereGeometry, outerSphereMaterial);
  outerSphere.visible = false;
  outerScene.add(outerSphere);
  
  // Debug outline for portal
  if (DEBUG_PORTAL_OUTLINE) {
    portalDebugOutline = createPortalDebugOutline(DOOR_WIDTH, DOOR_HEIGHT);
    portalDebugOutline.position.set(0, 0, OUTER_PORTAL_Z + 0.01);
    outerScene.add(portalDebugOutline);
  }
  
  setupInput();
  
  // Stats panel
  stats = new Stats();
  stats.showPanel(0); // 0: fps, 1: ms, 2: mb
  document.body.appendChild(stats.dom);
  
  requestAnimationFrame(update);
}

init().catch(console.error);
