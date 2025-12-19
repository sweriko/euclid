import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { Portal } from "./Portal";
import { computeObliqueProjectionMatrix } from "./PortalUtils";

/**
 * Configuration for a world that can be rendered through portals
 */
export interface PortalWorld {
  /** The Three.js scene */
  scene: THREE.Scene;
  /** Portals in this world (leading to other worlds) */
  portals: Portal[];
}

/**
 * Rendering options for portals
 */
export interface PortalRenderOptions {
  /** Maximum recursion depth for nested portals */
  maxRecursion?: number;
  /** Enable debug visualization */
  debug?: boolean;
}

/**
 * PortalRenderer handles stencil-based portal rendering.
 *
 * The rendering process:
 * 1. For each visible portal in the current world:
 *    a. Render portal quad to stencil buffer (marks portal region)
 *    b. Render destination world only where stencil is set
 *    c. Use oblique near-plane clipping to properly clip destination geometry
 * 2. Render current world normally (respecting stencil)
 *
 * This creates the effect of looking through a "window" into another world.
 */
export class PortalRenderer {
  private _renderer: WebGPURenderer;
  private _portalCamera: THREE.PerspectiveCamera;
  private _options: Required<PortalRenderOptions>;

  /** Materials for stencil operations */
  private _clearStencilMaterial: THREE.MeshBasicMaterial;

  constructor(renderer: WebGPURenderer, options: PortalRenderOptions = {}) {
    this._renderer = renderer;
    this._options = {
      maxRecursion: options.maxRecursion ?? 1,
      debug: options.debug ?? false,
    };

    // Create a camera for rendering through portals
    this._portalCamera = new THREE.PerspectiveCamera();

    // Material to clear stencil buffer
    this._clearStencilMaterial = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilZPass: THREE.ReplaceStencilOp,
    });
  }

  /**
   * Get the portal camera (for external use)
   */
  get portalCamera(): THREE.PerspectiveCamera {
    return this._portalCamera;
  }

  /**
   * Get the max recursion setting
   */
  get maxRecursion(): number {
    return this._options.maxRecursion;
  }

  /**
   * Render a scene with portal support.
   *
   * @param camera The main camera
   * @param currentWorld The world the camera is in
   * @param allWorlds All worlds that can be rendered (for destination lookup)
   */
  render(
    camera: THREE.PerspectiveCamera,
    currentWorld: PortalWorld,
    allWorlds: Map<string, PortalWorld>
  ): void {
    // Store original renderer state
    const originalAutoClear = this._renderer.autoClear;

    // Disable auto-clear for manual control
    this._renderer.autoClear = false;

    try {
      // Clear everything first
      this._renderer.clear(true, true, true);

      // Render portals from current world
      this._renderPortals(camera, currentWorld, allWorlds, 0);

      // Render the current world (excluding portal areas via stencil)
      this._renderWorldWithStencil(
        camera,
        currentWorld.scene,
        0,
        THREE.NotEqualStencilFunc
      );
    } finally {
      // Restore renderer state
      this._renderer.autoClear = originalAutoClear;
    }
  }

  /**
   * Simplified render for single portal pair (most common use case)
   */
  renderSimple(
    camera: THREE.PerspectiveCamera,
    currentScene: THREE.Scene,
    destinationScene: THREE.Scene,
    portal: Portal
  ): void {
    const originalAutoClear = this._renderer.autoClear;

    this._renderer.autoClear = false;

    try {
      // 1. Clear everything
      this._renderer.clear(true, true, true);

      if (portal.linkedPortal) {
        // 2. Render portal to stencil buffer only
        this._renderPortalStencil(portal, camera);

        // 3. Setup portal camera for destination view
        const destTransform = portal.getDestinationCameraTransform(
          camera.position,
          camera.quaternion
        );

        this._portalCamera.copy(camera);
        this._portalCamera.position.copy(destTransform.position);
        this._portalCamera.quaternion.copy(destTransform.quaternion);
        this._portalCamera.updateMatrixWorld(true);

        // 4. Compute oblique projection matrix (clips at destination portal plane)
        const destPortal = portal.linkedPortal;
        const clipPlane = destPortal.getPlane();
        // Flip normal to point toward camera
        clipPlane.negate();

        const obliqueMatrix = computeObliqueProjectionMatrix(
          this._portalCamera,
          clipPlane
        );
        this._portalCamera.projectionMatrix.copy(obliqueMatrix);
        this._portalCamera.projectionMatrixInverse.copy(obliqueMatrix).invert();

        // 5. Render destination scene through stencil
        this._renderSceneWithStencilTest(
          this._portalCamera,
          destinationScene,
          1,
          THREE.EqualStencilFunc
        );
      }

      // 6. Render current scene normally (stencil test: not equal to 1)
      this._renderSceneWithStencilTest(
        camera,
        currentScene,
        1,
        THREE.NotEqualStencilFunc
      );
    } finally {
      this._renderer.autoClear = originalAutoClear;
    }
  }

  /**
   * Render portals recursively
   */
  private _renderPortals(
    camera: THREE.PerspectiveCamera,
    currentWorld: PortalWorld,
    allWorlds: Map<string, PortalWorld>,
    depth: number
  ): void {
    if (depth >= this._options.maxRecursion) return;

    for (const portal of currentWorld.portals) {
      if (!portal.linkedPortal) continue;

      // Only render portal if camera is in front of it
      if (!portal.isPointInFront(camera.position)) continue;

      // Find destination world
      const destPortal = portal.linkedPortal;
      let destWorld: PortalWorld | undefined;
      for (const [, world] of allWorlds) {
        if (world.portals.includes(destPortal)) {
          destWorld = world;
          break;
        }
      }
      if (!destWorld) continue;

      // 1. Render portal to stencil
      this._renderPortalStencil(portal, camera, depth + 1);

      // 2. Setup portal camera
      const destTransform = portal.getDestinationCameraTransform(
        camera.position,
        camera.quaternion
      );

      this._portalCamera.copy(camera);
      this._portalCamera.position.copy(destTransform.position);
      this._portalCamera.quaternion.copy(destTransform.quaternion);
      this._portalCamera.updateMatrixWorld(true);

      // 3. Apply oblique projection
      const clipPlane = destPortal.getPlane();
      clipPlane.negate(); // Point toward camera

      const obliqueMatrix = computeObliqueProjectionMatrix(
        this._portalCamera,
        clipPlane
      );
      this._portalCamera.projectionMatrix.copy(obliqueMatrix);
      this._portalCamera.projectionMatrixInverse.copy(obliqueMatrix).invert();

      // 4. Recursively render portals in destination world
      this._renderPortals(this._portalCamera, destWorld, allWorlds, depth + 1);

      // 5. Render destination world through stencil
      this._renderSceneWithStencilTest(
        this._portalCamera,
        destWorld.scene,
        depth + 1,
        THREE.EqualStencilFunc
      );
    }
  }

  /**
   * Render a portal to the stencil buffer
   */
  private _renderPortalStencil(
    portal: Portal,
    camera: THREE.Camera,
    stencilValue: number = 1
  ): void {
    const mat = portal.mesh.material as THREE.MeshBasicMaterial;
    mat.stencilRef = stencilValue;

    // Ensure portal mesh is in the right state
    const scene = portal.scene;
    if (!scene) return;

    // Temporarily add portal mesh if not in scene
    const wasInScene = portal.mesh.parent === scene;
    if (!wasInScene) {
      scene.add(portal.mesh);
    }

    // Render just the portal mesh
    this._renderer.render(scene, camera);

    if (!wasInScene) {
      scene.remove(portal.mesh);
    }
  }

  /**
   * Render a scene with stencil test
   */
  private _renderSceneWithStencilTest(
    camera: THREE.Camera,
    scene: THREE.Scene,
    stencilRef: number,
    stencilFunc: THREE.StencilFunc
  ): void {
    // Apply stencil test to all materials in the scene
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh && object.material) {
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];

        for (const mat of materials) {
          mat.stencilWrite = false;
          mat.stencilFunc = stencilFunc;
          mat.stencilRef = stencilRef;
        }
      }
    });

    this._renderer.render(scene, camera);

    // Reset stencil state
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh && object.material) {
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];

        for (const mat of materials) {
          mat.stencilWrite = false;
          mat.stencilFunc = THREE.AlwaysStencilFunc;
        }
      }
    });
  }

  /**
   * Render world with stencil test
   */
  private _renderWorldWithStencil(
    camera: THREE.Camera,
    scene: THREE.Scene,
    stencilRef: number,
    stencilFunc: THREE.StencilFunc
  ): void {
    this._renderSceneWithStencilTest(camera, scene, stencilRef, stencilFunc);
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this._clearStencilMaterial.dispose();
  }
}
