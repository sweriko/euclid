import RAPIER from "@dimforge/rapier3d-compat";
import { Vector3, Euler, Quaternion } from "three";

export interface FPSControllerOptions {
  walkSpeed: number;
  sprintSpeed: number;
  strafeSpeed: number;
  backwardSpeed: number;
  jumpSpeed: number;
  mouseSensitivity: number;
  gravity: number;
  playerHeight: number;
  playerRadius: number;
}

export interface RoomBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  doorMinX: number;
  doorMaxX: number;
  doorMaxY: number;
  doorZ: number;
}

export interface OuterRoomObstacle {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  doorMinX: number;
  doorMaxX: number;
  doorMaxY: number;
  doorZ: number;
}

const DEFAULT_OPTIONS: FPSControllerOptions = {
  walkSpeed: 4,
  sprintSpeed: 7,
  strafeSpeed: 3,
  backwardSpeed: 2.5,
  jumpSpeed: 6,
  mouseSensitivity: 0.002,
  gravity: 18,
  playerHeight: 0.6,
  playerRadius: 0.2,
};

export class FPSController {
  public world: RAPIER.World;
  public collider: RAPIER.Collider;
  public rigidBody: RAPIER.RigidBody;
  public characterController: RAPIER.KinematicCharacterController;

  public position: Vector3 = new Vector3();
  public velocity: Vector3 = new Vector3();

  public yaw: number = 0;
  public pitch: number = 0;

  public options: FPSControllerOptions;
  public currentBounds: RoomBounds | null = null;
  public outerRoomObstacle: OuterRoomObstacle | null = null;

  private inputForward: number = 0;
  private inputRight: number = 0;
  private isSprinting: boolean = false;
  private wantsJump: boolean = false;
  private isGrounded: boolean = false;
  private verticalVelocity: number = 0;
  private tmpForward: Vector3 = new Vector3();
  private tmpRight: Vector3 = new Vector3();
  private tmpEuler: Euler = new Euler(0, 0, 0, "YXZ");
  private tmpQuat: Quaternion = new Quaternion();
  private tmpCamPos: Vector3 = new Vector3();
  private tmpDesiredMovement: { x: number; y: number; z: number } = {
    x: 0,
    y: 0,
    z: 0,
  };

  constructor(
    world: RAPIER.World,
    startPosition: Vector3,
    options: Partial<FPSControllerOptions> = {}
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.world = world;
    this.position.copy(startPosition);

    // Create kinematic rigid body
    const bodyDesc =
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        startPosition.x,
        startPosition.y,
        startPosition.z
      );
    this.rigidBody = world.createRigidBody(bodyDesc);

    // Create capsule collider
    const colliderDesc = RAPIER.ColliderDesc.capsule(
      this.options.playerHeight / 2,
      this.options.playerRadius
    );
    this.collider = world.createCollider(colliderDesc, this.rigidBody);

    // Create character controller
    this.characterController = world.createCharacterController(0.01); // offset
    this.characterController.setSlideEnabled(true);
    this.characterController.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.characterController.setMinSlopeSlideAngle((30 * Math.PI) / 180);
    this.characterController.enableAutostep(0.3, 0.2, true);
    this.characterController.enableSnapToGround(0.3);
  }

  setBounds(bounds: RoomBounds | null): void {
    this.currentBounds = bounds;
  }

  setMoveInput(forward: number, right: number): void {
    this.inputForward = Math.max(-1, Math.min(1, forward));
    this.inputRight = Math.max(-1, Math.min(1, right));
  }

  setSprinting(sprinting: boolean): void {
    this.isSprinting = sprinting;
  }

  jump(): void {
    if (this.isGrounded) {
      this.wantsJump = true;
    }
  }

  rotate(deltaX: number, deltaY: number): void {
    this.yaw -= deltaX * this.options.mouseSensitivity;
    this.pitch -= deltaY * this.options.mouseSensitivity;

    const maxPitch = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch));

    while (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    while (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  update(deltaS: number): void {
    // Calculate movement direction based on yaw
    const forward = this.tmpForward.set(
      -Math.sin(this.yaw),
      0,
      -Math.cos(this.yaw)
    );

    const right = this.tmpRight.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    // Build input direction in world space
    let inputX = 0;
    let inputZ = 0;

    // Determine speed
    let speed = this.options.walkSpeed;
    if (this.inputForward > 0) {
      speed = this.isSprinting
        ? this.options.sprintSpeed
        : this.options.walkSpeed;
    } else if (this.inputForward < 0) {
      speed = this.options.backwardSpeed;
    }

    // Forward/backward movement in look direction
    if (this.inputForward !== 0) {
      inputX += forward.x * this.inputForward;
      inputZ += forward.z * this.inputForward;
    }

    // Strafe in right direction
    if (this.inputRight !== 0) {
      const strafeSpeed =
        this.inputForward > 0 && this.isSprinting
          ? this.options.walkSpeed / this.options.sprintSpeed
          : this.options.strafeSpeed / speed;
      inputX += right.x * this.inputRight * strafeSpeed;
      inputZ += right.z * this.inputRight * strafeSpeed;
    }

    // Normalize if needed
    const inputLen = Math.sqrt(inputX * inputX + inputZ * inputZ);
    if (inputLen > 1) {
      inputX /= inputLen;
      inputZ /= inputLen;
    }

    // Handle vertical velocity
    if (this.isGrounded) {
      this.verticalVelocity = 0;
      if (this.wantsJump) {
        this.verticalVelocity = this.options.jumpSpeed;
        this.isGrounded = false;
      }
    } else {
      this.verticalVelocity -= this.options.gravity * deltaS;
    }
    this.wantsJump = false;

    // Calculate desired movement
    this.tmpDesiredMovement.x = inputX * speed * deltaS;
    this.tmpDesiredMovement.y = this.verticalVelocity * deltaS;
    this.tmpDesiredMovement.z = inputZ * speed * deltaS;

    // Compute movement using character controller
    this.characterController.computeColliderMovement(
      this.collider,
      this.tmpDesiredMovement,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined // filter groups
    );

    // Get corrected movement
    const correctedMovement = this.characterController.computedMovement();

    // Check if grounded
    this.isGrounded = this.characterController.computedGrounded();

    // Apply movement to position
    const currentPos = this.rigidBody.translation();
    const newX = currentPos.x + correctedMovement.x;
    const newY = currentPos.y + correctedMovement.y;
    const newZ = currentPos.z + correctedMovement.z;

    // Update rigid body position
    this.rigidBody.setNextKinematicTranslation({ x: newX, y: newY, z: newZ });

    // Update our position
    this.position.set(newX, newY, newZ);

    // Update velocity for reference
    this.velocity.set(inputX * speed, this.verticalVelocity, inputZ * speed);
  }

  syncFromPhysics(): void {
    const pos = this.rigidBody.translation();
    this.position.set(pos.x, pos.y, pos.z);
  }

  teleport(newPosition: Vector3): void {
    this.position.copy(newPosition);
    this.rigidBody.setTranslation(
      { x: newPosition.x, y: newPosition.y, z: newPosition.z },
      true
    );
    this.verticalVelocity = 0;
    this.velocity.set(0, 0, 0);
  }

  getCameraPosition(target: Vector3 = this.tmpCamPos): Vector3 {
    const eyeOffset =
      this.options.playerHeight / 2 + this.options.playerRadius * 0.8;
    return target.set(
      this.position.x,
      this.position.y + eyeOffset,
      this.position.z
    );
  }

  getCameraQuaternion(target: Quaternion = this.tmpQuat): Quaternion {
    this.tmpEuler.set(this.pitch, this.yaw, 0, "YXZ");
    return target.setFromEuler(this.tmpEuler);
  }

  getForwardDirection(target: Vector3 = this.tmpForward): Vector3 {
    return target.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  isOnGround(): boolean {
    return this.isGrounded;
  }
}
