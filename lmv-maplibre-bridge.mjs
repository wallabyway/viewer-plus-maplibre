import maplibregl from 'maplibre-gl';
import {
  initializeLmvSdk,
  resolveLmvRendererClass,
  createSharedLmvRenderer,
  createStoppedLmvViewer,
  loadLmvModel
} from './lmv-loader.mjs';

const THREE = window.THREE;

// ── Matrix helpers ────────────────────────────────────────────

/** Multiply two column-major 4×4 matrices using Float64 arithmetic. */
function multiplyMatrix4Float64(a, b) {
  const result = new Float64Array(16);

  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      result[row + column * 4] =
        a[row] * b[column * 4] +
        a[row + 4] * b[column * 4 + 1] +
        a[row + 8] * b[column * 4 + 2] +
        a[row + 12] * b[column * 4 + 3];
    }
  }

  return result;
}

/**
 * Create the geographic/model placement constants used by the bridge.
 * The model coordinates are in feet, while MapLibre's Mercator coordinates
 * are expressed in meters-at-the-model-location.
 */
export function createMercatorModelPlacement({
  origin,
  altitude,
  rotationDeg,
  unitScale
}) {
  const modelMercator = maplibregl.MercatorCoordinate.fromLngLat(origin, altitude);
  const rotationRad = (rotationDeg * Math.PI) / 180;

  return {
    origin,
    modelMercator,
    rotationCos: Math.cos(rotationRad),
    rotationSin: Math.sin(rotationRad),
    mercatorScale: modelMercator.meterInMercatorCoordinateUnits() * unitScale
  };
}

/**
 * Build the combined MapLibre view-projection/model matrix consumed by LMV.
 * The camera center is subtracted before the model transform to preserve
 * precision when MapLibre is rendering at large viewport sizes.
 */
function computeCombinedModelProjectionMatrix({ map, mainMatrix, placement }) {
  const cameraCenter = map.getCenter();
  const cameraMercator = maplibregl.MercatorCoordinate.fromLngLat(cameraCenter, 0);

  const dx = placement.modelMercator.x - cameraMercator.x;
  const dy = placement.modelMercator.y - cameraMercator.y;
  const dz = placement.modelMercator.z - (cameraMercator.z || 0);

  // Re-center the MapLibre view-projection matrix at the current map camera.
  const cameraTranslation = new Float64Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    cameraMercator.x, cameraMercator.y, cameraMercator.z || 0, 1
  ]);
  const centeredViewProjection = multiplyMatrix4Float64(mainMatrix, cameraTranslation);

  const scale = placement.mercatorScale;
  const modelMatrix = new Float64Array([
     scale * placement.rotationCos, -scale * placement.rotationSin, 0, 0,
    -scale * placement.rotationSin, -scale * placement.rotationCos, 0, 0,
     0,                            0,                             scale, 0,
     dx,                           dy,                            dz,    1
  ]);

  return multiplyMatrix4Float64(centeredViewProjection, modelMatrix);
}

/** Clean up WebGL state that LMV's R71 resetGLState does not touch. */
function restoreSharedWebGLState(gl, renderer) {
  renderer.resetGLState();
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
  gl.useProgram(null);
}

// ── Bridge ────────────────────────────────────────────────────

/**
 * Wires one LMV viewer into one MapLibre map. MapLibre remains the camera
 * owner; LMV renders into MapLibre's shared WebGL context using the
 * projection matrix supplied by the custom layer.
 *
 * Returns { layer, loadModel }: add `layer` to the map, call `loadModel(urn)`
 * once the layer has been added (it waits for viewer init internally).
 */
export function createLmvBridge({ container, modelPlacement, onStatus = () => {} }) {
  let map = null;
  let mapCanvas = null;
  let viewer = null;
  let ready = false;
  let viewerReady = null; // set in onAdd; awaited by loadModel
  let combinedMatrix64 = null;

  const combinedInverse = new THREE.Matrix4();
  const nearPoint = new THREE.Vector3();
  const farPoint = new THREE.Vector3();

  const layer = {
    id: 'lmv-model',
    type: 'custom',
    renderingMode: '3d',

    onAdd(mapInstance) {
      if (viewerReady) return;
      map = mapInstance;
      mapCanvas = mapInstance.getCanvas();
      viewerReady = initializeViewer();
    },

    render(gl, args) {
      if (!viewer) return;

      resizeLmvToMapCanvas();

      if (!ready) {
        viewer.impl.tick(performance.now());
        restoreSharedWebGLState(gl, viewer.impl.glrenderer());
        map?.triggerRepaint();
        return;
      }

      const renderer = viewer.impl.glrenderer();
      const combinedMatrix = computeCombinedModelProjectionMatrix({
        map,
        mainMatrix: args.defaultProjectionData.mainMatrix,
        placement: modelPlacement
      });

      applyMapLibreCameraTransform(combinedMatrix);

      renderer.resetGLState();
      renderer.setViewport(0, 0, mapCanvas.clientWidth, mapCanvas.clientHeight);

      viewer.impl.invalidate(true, true, true);
      viewer.impl.tick(performance.now());

      restoreSharedWebGLState(gl, renderer);
    }
  };

  async function initializeViewer() {
    onStatus('Initializing LMV...');
    await initializeLmvSdk();

    onStatus('Bootstrapping renderer...');
    const rendererClass = resolveLmvRendererClass();
    const sharedRenderer = createSharedLmvRenderer(rendererClass, mapCanvas);
    viewer = createStoppedLmvViewer(container, sharedRenderer, mapCanvas);

    // Keep the existing debug hook useful without making application code
    // depend on it.
    window.__lmvViewer = viewer;

    configureViewerForMapLibre();
  }

  function configureViewerForMapLibre() {
    bindLmvRepaintEvents();
    patchLmvCanvasBounds();
    patchLmvViewportToRay();
    bindMapPointerForwarding();
    viewer.impl.setRightBtnSelection(true);

    viewer.setGhosting(false);
    viewer.setGroundShadow(false);
    viewer.setLightPreset(1);
    viewer.impl.renderer().setAOEnabled(false);
  }

  function bindLmvRepaintEvents() {
    // LMV's own render loop is stopped — MapLibre owns frames. Subscribe to
    // every event LMV exposes (the names already live on Autodesk.Viewing),
    // so any GUI-driven state change (selection, visibility, isolate, panels,
    // resize...) schedules a MapLibre repaint without us maintaining a list.
    // Excluded: events fired BY rendering itself (they'd feed back into
    // triggerRepaint → tick → event forever) and PROGRESS_UPDATE, which
    // fires continuously while streaming.
    const EXCLUDED_EVENTS = new Set([
      'PROGRESS_UPDATE_EVENT',
      'RENDERING_TICKED_EVENT',
      'RENDER_PRESENTED_EVENT'
    ]);
    const eventTypes = [...new Set(
      Object.keys(Autodesk.Viewing)
        .filter(name => name.endsWith('_EVENT') && !EXCLUDED_EVENTS.has(name))
        .map(name => Autodesk.Viewing[name])
        .filter(value => typeof value === 'string')
    )];

    // Model-browser actions such as isolate/fit-to-view can update LMV's
    // own camera after the visibility event has fired. On these events the
    // bridge must also cancel LMV's camera transition so impl.tick() can't
    // overwrite MapLibre's projection before the shared canvas is presented.
    const cameraEvents = new Set([
      Autodesk.Viewing.FIT_TO_VIEW_EVENT,
      Autodesk.Viewing.AGGREGATE_FIT_TO_VIEW_EVENT,
      Autodesk.Viewing.CAMERA_CHANGE_EVENT
    ].filter(Boolean));

    for (const eventType of eventTypes) {
      viewer.addEventListener(eventType, () => {
        if (ready && cameraEvents.has(eventType)) {
          cancelLmvCameraTransition();
        }
        map?.triggerRepaint();
      });
    }
  }

  function cancelLmvCameraTransition() {
    const navigation = viewer?.navigation;
    navigation?.setRequestTransition?.(false);
    navigation?.setRequestFitToView?.(false);
    navigation?.setRequestHomeView?.(false);
    if (navigation?.getTransitionActive?.()) {
      navigation.setTransitionActive(false);
    }

    // Autocam schedules the fit animation independently with requestAnimationFrame.
    // Stop that callback as well, otherwise impl.tick() can overwrite the map
    // projection again after the bridge has applied it.
    const autocam = viewer?.autocam;
    if (autocam?.afAnimateTransition !== undefined &&
        autocam?.afAnimateTransition !== null) {
      cancelAnimationFrame(autocam.afAnimateTransition);
      autocam.afAnimateTransition = null;
    }
    if (autocam) autocam.currentlyAnimating = false;
  }

  function patchLmvCanvasBounds() {
    // The LMV canvas is display:none. Use the visible MapLibre canvas for
    // clientToViewport and context-menu coordinate conversion.
    viewer.impl.getCanvasBoundingClientRect = () =>
      mapCanvas.getBoundingClientRect();
  }

  function patchLmvViewportToRay() {
    // LMV's stock implementation uses camera.position and matrixWorld. This
    // integration pins both to identity and puts the complete MapLibre view
    // in projectionMatrix, so unproject through that combined matrix instead.
    const camera = viewer.impl.camera;
    const stockViewportToRay = camera.viewportToRay.bind(camera);

    camera.viewportToRay = (viewport, ray) => {
      if (!combinedMatrix64) return stockViewportToRay(viewport, ray);

      ray ||= new THREE.Ray();
      combinedInverse.fromArray(combinedMatrix64).invert();

      // LMV uses legacy R71 Vector3 semantics: applyMatrix4 assumes an
      // affine matrix and does not perform the homogeneous divide.
      nearPoint
        .set(viewport.x, viewport.y, -1)
        .applyProjection(combinedInverse);
      farPoint
        .set(viewport.x, viewport.y, 1)
        .applyProjection(combinedInverse);

      ray.origin.copy(nearPoint);
      ray.direction.copy(farPoint).sub(nearPoint).normalize();
      return ray;
    };
  }

  function bindMapPointerForwarding() {
    mapCanvas.addEventListener('contextmenu', event => event.preventDefault());

    for (const type of ['mousedown', 'mouseup']) {
      mapCanvas.addEventListener(type, event => {
        if (event.button !== 2 || !viewer?.canvas) return;

        viewer.canvas.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 2,
          buttons: event.buttons,
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY
        }));
      });
    }
  }

  async function loadModel(urn) {
    await viewerReady;

    ready = false;
    onStatus('Loading model...');
    await loadLmvModel(viewer, urn);
    ready = true;

    onStatus('Model loaded');
    map?.triggerRepaint();
  }

  function resizeLmvToMapCanvas() {
    // Keep LMV sized to MapLibre's *actual* backing store. Past the
    // maxCanvasSize clamp MapLibre lowers its applied pixel ratio; LMV's
    // own resize handling uses raw devicePixelRatio and must be corrected.
    const appliedPixelRatio = mapCanvas.clientWidth
      ? mapCanvas.width / mapCanvas.clientWidth
      : 1;
    const renderer = viewer.impl.glrenderer();
    const currentPixelRatio = renderer.getPixelRatio?.() || 1;

    if (appliedPixelRatio > 0 &&
        Math.abs(currentPixelRatio - appliedPixelRatio) > 1e-3) {
      // LMV's own resize would skip setPixelRatio when it matches raw
      // devicePixelRatio, so set it ourselves BEFORE the FBO realloc.
      renderer.setPixelRatio(appliedPixelRatio);
      viewer.impl.resize(
        mapCanvas.clientWidth,
        mapCanvas.clientHeight,
        true
      );
    }
  }

  function applyMapLibreCameraTransform(combinedMatrix) {
    const camera = viewer.impl.camera;
    camera.projectionMatrix.elements.set(new Float32Array(combinedMatrix));
    combinedMatrix64 = combinedMatrix;

    camera.position.set(0, 0, 0);
    if (camera.quaternion) camera.quaternion.set(0, 0, 0, 1);
    if (camera.rotation) camera.rotation.set(0, 0, 0);
    camera.scale.set(1, 1, 1);
    camera.matrixWorld.identity();
    camera.matrixWorldInverse.identity();
  }

  return { layer, loadModel };
}
