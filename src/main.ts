import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import Stats from "three/examples/jsm/libs/stats.module.js";
import { WebGPURenderer, MeshStandardNodeMaterial } from "three/webgpu";
import {
  color,
  normalWorld,
  float,
  vec3,
  mix,
  smoothstep,
  sin,
  time,
  positionWorld,
  Fn,
  If,
  Discard,
} from "three/tsl";
import RAPIER from "@dimforge/rapier3d-compat";
import { FPSController, RoomBounds } from "./character/FPSController";
import { resizeRendererToDisplaySize } from "./helpers/responsiveness";
import { Portal, computeObliqueProjectionMatrix } from "./portal";

// ============================================
// CONSTANTS
// ============================================
const DOOR_WIDTH = 0.9;
const DOOR_HEIGHT = 1.6;
const OUTER_DOOR_FRAME_THICKNESS = 0.12;
const OUTER_DOOR_FRAME_DEPTH = 0.2;

// Inner room: spacious cabin (like TARDIS - bigger on the inside)
const INNER_ROOM_WIDTH = 6;
const INNER_ROOM_DEPTH = 10;
const INNER_ROOM_HEIGHT = 6;
const GROUND_SIZE = 50;

// Portal positions (z coordinate of the door plane)
const OUTER_PORTAL_Z = 0.6;
const INNER_PORTAL_Z = INNER_ROOM_DEPTH / 2;

// Separate the inner world to avoid overlap
const INNER_WORLD_OFFSET = 100;

// Room bounds for collision (inner room)
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
let stats: Stats;

// Portals
let outerPortal: Portal;
let innerPortal: Portal;

// Animated objects
let innerSphere: THREE.Mesh;
let outerSphere: THREE.Mesh;
let outerSphereMaterial: MeshStandardNodeMaterial;
let innerSphereMaterial: MeshStandardNodeMaterial;

// Pushable cube
let pushCubeBody: RAPIER.RigidBody;
let pushCubeMeshOuter: THREE.Mesh;
let pushCubeMeshInner: THREE.Mesh;
let pushCubeOuterMaterial: MeshStandardNodeMaterial;
let pushCubeInnerMaterial: MeshStandardNodeMaterial;
let pushCubeInInnerWorld = false;
const PUSH_CUBE_SIZE = 0.3;

// Track which world the player is in
let isInInnerRoom = false;
let lastPortalSide = 1;

// Input state
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
// MATERIALS
// ============================================
function createOuterRoomMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();

  const worldPos = positionWorld;
  const noiseScale = float(0.5);
  const variation = sin(worldPos.x.mul(noiseScale))
    .mul(sin(worldPos.y.mul(noiseScale)))
    .mul(sin(worldPos.z.mul(noiseScale)));

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
  const variation = sin(worldPos.x.mul(scale1).add(worldPos.z.mul(scale2)))
    .mul(0.1)
    .add(0.9);

  const grassColor = color(0x3d5c3d);

  material.colorNode = grassColor.mul(variation);
  material.roughnessNode = float(0.9);
  material.metalnessNode = float(0.0);

  material.polygonOffset = true;
  material.polygonOffsetFactor = 1;
  material.polygonOffsetUnits = 1;

  return material;
}

/**
 * Create a material that clips at the portal plane.
 * Used for objects that cross through the portal.
 */
function createClippedSphereMaterial(
  clipZ: number,
  keepFront: boolean
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  const hueShift = sin(time.mul(0.5)).mul(0.1).add(0.55);

  const clipPlaneZ = float(clipZ);

  material.colorNode = Fn(() => {
    if (keepFront) {
      If(positionWorld.z.lessThan(clipPlaneZ), () => {
        Discard();
      });
    } else {
      If(positionWorld.z.greaterThan(clipPlaneZ), () => {
        Discard();
      });
    }
    return vec3(hueShift, float(0.3), float(0.7));
  })();

  material.roughnessNode = float(0.2);
  material.metalnessNode = float(0.8);
  material.emissiveNode = vec3(hueShift.mul(0.2), float(0.05), float(0.1));
  material.side = THREE.DoubleSide;

  return material;
}

function createPushCubeMaterial(
  clipZ: number | null,
  keepFront: boolean
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  const baseColor = color(0xe07030);

  if (clipZ !== null) {
    const clipPlaneZ = float(clipZ);
    material.colorNode = Fn(() => {
      if (keepFront) {
        If(positionWorld.z.lessThan(clipPlaneZ), () => {
          Discard();
        });
      } else {
        If(positionWorld.z.greaterThan(clipPlaneZ), () => {
          Discard();
        });
      }
      return baseColor;
    })();
  } else {
    material.colorNode = baseColor;
  }

  material.roughnessNode = float(0.4);
  material.metalnessNode = float(0.1);
  material.side = THREE.DoubleSide;

  return material;
}

// ============================================
// GEOMETRY CREATION
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
  geometries.forEach((g) => g.dispose());

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

  const leftPost = new THREE.BoxGeometry(
    frameThickness,
    postHeight,
    frameDepth
  );
  leftPost.translate(-doorWidth / 2 - frameThickness / 2, postHeight / 2, 0);
  parts.push(leftPost);

  const rightPost = new THREE.BoxGeometry(
    frameThickness,
    postHeight,
    frameDepth
  );
  rightPost.translate(doorWidth / 2 + frameThickness / 2, postHeight / 2, 0);
  parts.push(rightPost);

  const topBeam = new THREE.BoxGeometry(
    doorWidth + frameThickness * 2,
    frameThickness,
    frameDepth
  );
  topBeam.translate(0, doorHeight + frameThickness / 2, 0);
  parts.push(topBeam);

  const merged = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());

  return merged;
}

// ============================================
// SCENE CREATION
// ============================================
function createOuterWorld(): THREE.Group {
  const group = new THREE.Group();

  // Ground
  const groundGeometry = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE);
  groundGeometry.rotateX(-Math.PI / 2);
  const groundMaterial = createGroundMaterial();
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  group.add(ground);

  // Outer portal frame
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

  const roomGeometry = createRoomWithDoorGeometry(
    INNER_ROOM_WIDTH,
    INNER_ROOM_HEIGHT,
    INNER_ROOM_DEPTH,
    DOOR_WIDTH,
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
  // Columns
  const columnGeometry = new THREE.CylinderGeometry(
    0.2,
    0.25,
    INNER_ROOM_HEIGHT - 0.2,
    16
  );
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

  columnPositions.forEach((pos) => {
    const column = new THREE.Mesh(columnGeometry, columnMaterial);
    column.position.set(pos[0], pos[1], pos[2]);
    group.add(column);
  });

  // Animated sphere (inside the inner room)
  const sphereGeometry = new THREE.SphereGeometry(0.4, 32, 32);
  innerSphereMaterial = new MeshStandardNodeMaterial();
  const hueShift = sin(time.mul(0.5)).mul(0.1).add(0.55);
  innerSphereMaterial.colorNode = vec3(hueShift, float(0.3), float(0.7));
  innerSphereMaterial.roughnessNode = float(0.2);
  innerSphereMaterial.metalnessNode = float(0.8);
  innerSphereMaterial.emissiveNode = vec3(
    hueShift.mul(0.2),
    float(0.05),
    float(0.1)
  );

  innerSphere = new THREE.Mesh(sphereGeometry, innerSphereMaterial);
  innerSphere.position.set(0, 2.5, -2);
  group.add(innerSphere);

  // Furniture
  const cubeGeometry = new THREE.BoxGeometry(1.2, 0.8, 1.2);
  const cubeMaterial = new MeshStandardNodeMaterial();
  cubeMaterial.colorNode = color(0x5c4033);
  cubeMaterial.roughnessNode = float(0.7);

  const cubePositions = [
    [-2, 0.4, -4],
    [2, 0.4, -4],
    [0, 0.4, -4],
  ];

  cubePositions.forEach((pos) => {
    const cube = new THREE.Mesh(cubeGeometry, cubeMaterial);
    cube.position.set(pos[0], pos[1], pos[2]);
    group.add(cube);
  });
}

function createLighting(scene: THREE.Scene, isInner: boolean): void {
  const ambient = new THREE.AmbientLight(
    isInner ? 0x505050 : 0x606070,
    isInner ? 0.5 : 0.6
  );
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
// PORTAL SETUP
// ============================================
function setupPortals(): void {
  // Create outer portal (in the outer world, facing +Z)
  outerPortal = new Portal(
    "outer",
    DOOR_WIDTH,
    DOOR_HEIGHT,
    new THREE.Vector3(0, 0, OUTER_PORTAL_Z),
    new THREE.Euler(0, 0, 0)
  );
  outerPortal.scene = outerScene;

  // Create inner portal (in the inner world, facing -Z / toward room interior)
  innerPortal = new Portal(
    "inner",
    DOOR_WIDTH,
    DOOR_HEIGHT,
    new THREE.Vector3(0, 0, INNER_WORLD_OFFSET + INNER_PORTAL_Z),
    new THREE.Euler(0, Math.PI, 0) // Rotated to face into the room
  );
  innerPortal.scene = innerScene;

  // Link portals
  outerPortal.link(innerPortal);

  // Add portal meshes to scenes
  outerScene.add(outerPortal.mesh);
  innerScene.add(innerPortal.mesh);
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
    RAPIER.ColliderDesc.cuboid(
      GROUND_SIZE / 2,
      0.5,
      GROUND_SIZE / 2
    ).setFriction(0.8),
    groundBody
  );

  createOuterDoorFrameCollision();
  createInnerRoomCollision();

  controller = new FPSController(physicsWorld, new THREE.Vector3(0, 1, 5), {
    walkSpeed: 4,
    sprintSpeed: 7,
    strafeSpeed: 3,
    backwardSpeed: 2.5,
    jumpSpeed: 6,
    mouseSensitivity: 0.002,
    gravity: 18,
    playerHeight: 0.6,
    playerRadius: 0.2,
  });

  controller.setBounds(null);

  createPushableCube();
}

function createPushableCube(): void {
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic().setTranslation(
    1.5,
    PUSH_CUBE_SIZE / 2 + 0.01,
    1.5
  );
  pushCubeBody = physicsWorld.createRigidBody(bodyDesc);

  const colliderDesc = RAPIER.ColliderDesc.cuboid(
    PUSH_CUBE_SIZE / 2,
    PUSH_CUBE_SIZE / 2,
    PUSH_CUBE_SIZE / 2
  )
    .setFriction(0.8)
    .setRestitution(0.05)
    .setMass(1);

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

  const cubeInSameWorld = pushCubeInInnerWorld === isInInnerRoom;

  if (cubeInSameWorld) {
    const dx = pos.x - playerPos.x;
    const dz = pos.z - playerPos.z;
    const distHorizontal = Math.sqrt(dx * dx + dz * dz);
    const cubeBottom = pos.y - PUSH_CUBE_SIZE / 2;
    const cubeTop = pos.y + PUSH_CUBE_SIZE / 2;
    const playerTop = playerPos.y + playerHalfHeight;
    const playerBottom = playerPos.y - playerHalfHeight;

    const verticalOverlap =
      playerBottom < cubeTop + 0.1 && playerTop > cubeBottom - 0.1;

    if (
      distHorizontal < pushRadius &&
      verticalOverlap &&
      distHorizontal > 0.01
    ) {
      pushCubeBody.wakeUp();

      const overlap = pushRadius - distHorizontal;
      const pushDir = { x: dx / distHorizontal, z: dz / distHorizontal };
      const pushSpeed = Math.min(overlap * 8.0, 2.5);

      const curVel = pushCubeBody.linvel();
      pushCubeBody.setLinvel(
        { x: pushDir.x * pushSpeed, y: curVel.y, z: pushDir.z * pushSpeed },
        true
      );
    }
  }

  // Check portal crossing for cube
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
    const crossingPortal =
      pos.z > innerPortalZ && pos.z < innerPortalZ + cubeHalf + 0.1;

    if (inDoorX && inDoorY && crossingPortal) {
      teleportCubeToOuter();
    }
  }

  // Update cube visibility and clipping
  updateCubeVisuals(pos, rot);
}

function updateCubeVisuals(
  pos: { x: number; y: number; z: number },
  rot: { x: number; y: number; z: number; w: number }
): void {
  const cubeHalfSize = PUSH_CUBE_SIZE / 2;
  let distFromPortal: number;

  if (pushCubeInInnerWorld) {
    distFromPortal = pos.z - (INNER_WORLD_OFFSET + INNER_PORTAL_Z);
  } else {
    distFromPortal = pos.z - OUTER_PORTAL_Z;
  }

  const cubeInDoorArea =
    Math.abs(pos.x) < DOOR_WIDTH / 2 + cubeHalfSize &&
    pos.y < DOOR_HEIGHT + cubeHalfSize;
  const nearPortalZ = Math.abs(distFromPortal) < cubeHalfSize + 0.5;
  const usePortalVisuals = cubeInDoorArea && nearPortalZ;

  if (usePortalVisuals) {
    // Outer mesh: show part in front of outer portal
    pushCubeMeshOuter.position.set(
      pos.x,
      pos.y,
      OUTER_PORTAL_Z + distFromPortal
    );
    pushCubeMeshOuter.quaternion.set(rot.x, rot.y, rot.z, rot.w);

    // Inner mesh: show part behind inner portal (in room)
    pushCubeMeshInner.position.set(
      pos.x,
      pos.y,
      INNER_WORLD_OFFSET + INNER_PORTAL_Z + distFromPortal
    );
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

  const addCollider = (
    hx: number,
    hy: number,
    hz: number,
    x: number,
    y: number,
    z: number
  ) => {
    const body = physicsWorld.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z)
    );
    physicsWorld.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.5),
      body
    );
  };

  addCollider(
    t / 2,
    postHeight / 2,
    d / 2,
    -DOOR_WIDTH / 2 - t / 2,
    postY,
    postZ
  );
  addCollider(
    t / 2,
    postHeight / 2,
    d / 2,
    DOOR_WIDTH / 2 + t / 2,
    postY,
    postZ
  );
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

  const addCollider = (
    hx: number,
    hy: number,
    hz: number,
    x: number,
    y: number,
    z: number,
    friction = 0.5
  ) => {
    const body = physicsWorld.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z)
    );
    physicsWorld.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(friction),
      body
    );
  };

  // Floor
  addCollider(
    INNER_ROOM_WIDTH / 2,
    wallThickness / 2,
    INNER_ROOM_DEPTH / 2,
    0,
    -wallThickness / 2,
    oz,
    0.8
  );

  // Ceiling
  addCollider(
    INNER_ROOM_WIDTH / 2,
    wallThickness / 2,
    INNER_ROOM_DEPTH / 2,
    0,
    INNER_ROOM_HEIGHT + wallThickness / 2,
    oz
  );

  // Back wall
  addCollider(
    INNER_ROOM_WIDTH / 2,
    INNER_ROOM_HEIGHT / 2,
    wallThickness / 2,
    0,
    hh,
    oz - hd - wallThickness / 2
  );

  // Left wall
  addCollider(
    wallThickness / 2,
    INNER_ROOM_HEIGHT / 2,
    INNER_ROOM_DEPTH / 2,
    -hw - wallThickness / 2,
    hh,
    oz
  );

  // Right wall
  addCollider(
    wallThickness / 2,
    INNER_ROOM_HEIGHT / 2,
    INNER_ROOM_DEPTH / 2,
    hw + wallThickness / 2,
    hh,
    oz
  );

  // Front wall sections around door
  const sideWidth = hw - doorHW;
  if (sideWidth > 0.05) {
    addCollider(
      sideWidth / 2,
      INNER_ROOM_HEIGHT / 2,
      wallThickness / 2,
      -doorHW - sideWidth / 2,
      hh,
      oz + hd + wallThickness / 2
    );
    addCollider(
      sideWidth / 2,
      INNER_ROOM_HEIGHT / 2,
      wallThickness / 2,
      doorHW + sideWidth / 2,
      hh,
      oz + hd + wallThickness / 2
    );
  }

  // Top section above door
  const topHeight = INNER_ROOM_HEIGHT - doorH;
  if (topHeight > 0.05) {
    addCollider(
      DOOR_WIDTH / 2,
      topHeight / 2,
      wallThickness / 2,
      0,
      doorH + topHeight / 2,
      oz + hd + wallThickness / 2
    );
  }
}

// ============================================
// INPUT HANDLING
// ============================================
function setupInput(): void {
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("pointerlockchange", onPointerLockChange);

  const canvas = document.getElementById("canvas")!;
  canvas.addEventListener("click", () => {
    if (!isPointerLocked) {
      canvas.requestPointerLock();
    }
  });
}

function onKeyDown(e: KeyboardEvent): void {
  switch (e.code) {
    case "KeyW":
    case "ArrowUp":
      inputState.forward = true;
      break;
    case "KeyS":
    case "ArrowDown":
      inputState.backward = true;
      break;
    case "KeyA":
    case "ArrowLeft":
      inputState.left = true;
      break;
    case "KeyD":
    case "ArrowRight":
      inputState.right = true;
      break;
    case "Space":
      inputState.jump = true;
      break;
    case "ShiftLeft":
    case "ShiftRight":
      inputState.sprint = true;
      break;
  }
}

function onKeyUp(e: KeyboardEvent): void {
  switch (e.code) {
    case "KeyW":
    case "ArrowUp":
      inputState.forward = false;
      break;
    case "KeyS":
    case "ArrowDown":
      inputState.backward = false;
      break;
    case "KeyA":
    case "ArrowLeft":
      inputState.left = false;
      break;
    case "KeyD":
    case "ArrowRight":
      inputState.right = false;
      break;
    case "Space":
      inputState.jump = false;
      break;
    case "ShiftLeft":
    case "ShiftRight":
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
// PORTAL TRAVERSAL
// ============================================
function checkPortalTraversal(): void {
  const pos = controller.position;
  const portalZ = isInInnerRoom
    ? INNER_WORLD_OFFSET + INNER_PORTAL_Z
    : OUTER_PORTAL_Z;

  const portalNormalZ = isInInnerRoom ? -1 : 1;
  const signedDist = (pos.z - portalZ) * portalNormalZ;
  const currentSide = signedDist > 0 ? 1 : -1;
  const previousSide = lastPortalSide;
  lastPortalSide = currentSide;

  const doorHalfWidth = DOOR_WIDTH / 2;
  const doorHeight = DOOR_HEIGHT;

  const inDoorX = Math.abs(pos.x) < doorHalfWidth;
  const inDoorY = pos.y > 0 && pos.y < doorHeight + 0.5;
  const nearPortal = Math.abs(pos.z - portalZ) < 0.4;
  const crossedFromFrontToBack = previousSide === 1 && currentSide === -1;

  if (inDoorX && inDoorY && nearPortal && crossedFromFrontToBack) {
    teleportThroughPortal();
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
    lastPortalSide = 1;
  } else {
    const distFromPortal = pos.z - outerPortalZ;
    const newZ = innerPortalZ + distFromPortal;

    controller.teleport(new THREE.Vector3(pos.x, pos.y, newZ));
    controller.setBounds(INNER_ROOM_BOUNDS);
    isInInnerRoom = true;
    lastPortalSide = 1;
  }
}

// ============================================
// STENCIL PORTAL RENDERING
// ============================================

/**
 * Render with stencil-based portal.
 *
 * The process:
 * 1. Clear everything
 * 2. Render portal quad to stencil only (marks portal region with value 1)
 * 3. Render destination world only where stencil == 1 (with oblique clipping)
 * 4. Render current world only where stencil != 1
 */
function renderWithStencilPortal(): void {
  const currentPortal = isInInnerRoom ? innerPortal : outerPortal;
  const destPortal = isInInnerRoom ? outerPortal : innerPortal;
  const currentScene = isInInnerRoom ? innerScene : outerScene;
  const destScene = isInInnerRoom ? outerScene : innerScene;

  // Store original state
  const originalAutoClear = renderer.autoClear;
  renderer.autoClear = false;

  // 1. Clear everything
  renderer.clear(true, true, true);

  // 2. Render portal to stencil buffer only
  // The portal mesh already has stencilWrite: true, colorWrite: false, depthWrite: false
  currentPortal.setStencilRef(1);

  // Temporarily make only portal mesh visible for stencil pass
  setSceneVisibility(currentScene, false);
  currentPortal.mesh.visible = true;

  renderer.render(currentScene, camera);

  // Restore scene visibility
  setSceneVisibility(currentScene, true);
  currentPortal.mesh.visible = false; // Hide stencil mesh for normal render

  // 3. Render destination world through portal (where stencil == 1)
  // Setup portal camera
  const destTransform = currentPortal.getDestinationCameraTransform(
    camera.position,
    camera.quaternion
  );

  portalCamera.copy(camera);
  portalCamera.position.copy(destTransform.position);
  portalCamera.quaternion.copy(destTransform.quaternion);
  portalCamera.updateMatrixWorld(true);

  // Apply oblique projection (clips at destination portal plane)
  const clipPlane = destPortal.getPlane();
  clipPlane.negate(); // Point toward camera

  const obliqueMatrix = computeObliqueProjectionMatrix(portalCamera, clipPlane);
  portalCamera.projectionMatrix.copy(obliqueMatrix);
  portalCamera.projectionMatrixInverse.copy(obliqueMatrix).invert();

  // Set stencil test on destination scene materials
  setSceneStencilTest(destScene, 1, THREE.EqualStencilFunc);

  // Clear only depth (keep stencil), then render destination
  renderer.clearDepth();
  renderer.render(destScene, portalCamera);

  // Reset stencil test
  setSceneStencilTest(destScene, 0, THREE.AlwaysStencilFunc);

  // 4. Render current world (where stencil != 1)
  setSceneStencilTest(currentScene, 1, THREE.NotEqualStencilFunc);

  // Clear depth again for current world
  renderer.clearDepth();
  renderer.render(currentScene, camera);

  // Reset stencil test
  setSceneStencilTest(currentScene, 0, THREE.AlwaysStencilFunc);

  // Restore state
  renderer.autoClear = originalAutoClear;
}

function setSceneVisibility(scene: THREE.Scene, visible: boolean): void {
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Light) {
      obj.visible = visible;
    }
  });
}

function setSceneStencilTest(
  scene: THREE.Scene,
  stencilRef: number,
  stencilFunc: THREE.StencilFunc
): void {
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.material) {
      const materials = Array.isArray(obj.material)
        ? obj.material
        : [obj.material];
      for (const mat of materials) {
        mat.stencilWrite = false;
        mat.stencilFunc = stencilFunc;
        mat.stencilRef = stencilRef;
      }
    }
  });
}

// ============================================
// SPHERE ANIMATION
// ============================================
let sphereDistFromPortal = 0;

function updateAnimatedSphere(currentTime: number): void {
  if (!innerSphere || !outerSphere) return;

  const t = currentTime * 0.001;
  const travelRange = 3;
  const cyclePos = Math.sin(t * 0.5) * travelRange - 1;

  const localY = DOOR_HEIGHT * 0.5;
  const localX = 0;

  sphereDistFromPortal = cyclePos;

  // Position spheres relative to their portals
  outerSphere.position.set(
    localX,
    localY,
    OUTER_PORTAL_Z + sphereDistFromPortal
  );
  innerSphere.position.set(
    localX,
    localY,
    INNER_PORTAL_Z + sphereDistFromPortal
  );

  // Control visibility based on which side of portal
  const SPHERE_RADIUS = 0.4;
  const hasOutsidePart = sphereDistFromPortal > -SPHERE_RADIUS;
  const hasInsidePart = sphereDistFromPortal < SPHERE_RADIUS;

  // When rendering the outer world through portal (from inner), show outer sphere
  // When rendering the inner world through portal (from outer), show inner sphere
  outerSphere.visible = hasOutsidePart;
  innerSphere.visible = hasInsidePart;
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

  // Handle resize
  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  if (resizeRendererToDisplaySize(renderer, pixelRatio)) {
    const width = renderer.domElement.clientWidth;
    const height = renderer.domElement.clientHeight;

    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    portalCamera.aspect = camera.aspect;
    portalCamera.updateProjectionMatrix();
  }

  // Update controller input
  const forwardInput =
    (inputState.forward ? 1 : 0) - (inputState.backward ? 1 : 0);
  const rightInput = (inputState.right ? 1 : 0) - (inputState.left ? 1 : 0);
  controller.setMoveInput(forwardInput, rightInput);
  controller.setSprinting(inputState.sprint);

  if (inputState.jump) {
    controller.jump();
  }

  controller.rotate(pendingMouseX, pendingMouseY);
  pendingMouseX = 0;
  pendingMouseY = 0;

  controller.update(deltaS);

  // Step physics
  physicsWorld.step();
  controller.syncFromPhysics();

  // Check portal traversal
  checkPortalTraversal();

  // Update animated objects
  updateAnimatedSphere(currentTime);
  updatePushableCube();

  // Update camera
  const camPos = controller.getCameraPosition();
  camera.position.copy(camPos);
  camera.quaternion.copy(controller.getCameraQuaternion());
  camera.updateMatrixWorld(true);

  // Render with stencil-based portals
  renderWithStencilPortal();

  stats.end();
}

// ============================================
// INITIALIZATION
// ============================================
async function init(): Promise<void> {
  await RAPIER.init();

  physicsWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  const canvas = document.getElementById("canvas") as HTMLCanvasElement;

  renderer = new WebGPURenderer({
    canvas,
    antialias: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  await renderer.init();

  // Create scenes
  outerScene = new THREE.Scene();
  outerScene.background = new THREE.Color(0x87ceeb);
  const outerWorld = createOuterWorld();
  outerScene.add(outerWorld);
  createLighting(outerScene, false);

  innerScene = new THREE.Scene();
  innerScene.background = new THREE.Color(0x1a1510);
  const innerWorld = createInnerWorld();
  innerWorld.position.z = INNER_WORLD_OFFSET;
  innerScene.add(innerWorld);
  createLighting(innerScene, true);

  // Cameras
  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.01,
    200
  );
  portalCamera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.01,
    200
  );

  // Setup portals
  setupPortals();

  // Setup physics
  setupPhysics();

  // Create pushable cube visuals
  const pushCubeGeometry = new THREE.BoxGeometry(
    PUSH_CUBE_SIZE,
    PUSH_CUBE_SIZE,
    PUSH_CUBE_SIZE
  );

  pushCubeOuterMaterial = createPushCubeMaterial(OUTER_PORTAL_Z, true);
  pushCubeMeshOuter = new THREE.Mesh(pushCubeGeometry, pushCubeOuterMaterial);
  outerScene.add(pushCubeMeshOuter);

  pushCubeInnerMaterial = createPushCubeMaterial(
    INNER_WORLD_OFFSET + INNER_PORTAL_Z,
    false
  );
  pushCubeMeshInner = new THREE.Mesh(pushCubeGeometry, pushCubeInnerMaterial);
  innerScene.add(pushCubeMeshInner);

  // Create outer sphere (clipped version that appears in outer world)
  const outerSphereGeometry = new THREE.SphereGeometry(0.4, 32, 32);
  outerSphereMaterial = createClippedSphereMaterial(OUTER_PORTAL_Z, true);
  outerSphere = new THREE.Mesh(outerSphereGeometry, outerSphereMaterial);
  outerSphere.visible = false;
  outerScene.add(outerSphere);

  setupInput();

  stats = new Stats();
  stats.showPanel(0);
  document.body.appendChild(stats.dom);

  requestAnimationFrame(update);
}

init().catch(console.error);
