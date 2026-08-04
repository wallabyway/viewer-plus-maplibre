const API_BASE = import.meta.env.DEV
  ? '/api'
  : 'https://d1rfabreh9lcnl.cloudfront.net/api';

const fetchAccessToken = () => fetch(`${API_BASE}/auth/token`).then(r => r.json());

export const fetchModelCatalog = () =>
  fetch(`${API_BASE}/models/buckets?id=samplemodels`)
    .then(r => r.json())
    .then(items => items.map(m => ({ name: m.text, urn: m.id })));

export async function initializeLmvSdk() {
  const token = await fetchAccessToken();

  // LMV >= 7.119 enables "Large Model Experience" (HLOD / out-of-core tile
  // manager) by default. Its geometry streaming stalls when the viewer is
  // driven manually like we do here (impl.stop() + external tick()), so
  // geometry never loads and GEOMETRY_LOADED_EVENT never fires.
  //
  if (Autodesk.Viewing.FeatureFlags?._setInitializationData) {
    Autodesk.Viewing.FeatureFlags._setInitializationData(
      'LARGE_MODEL_EXPERIENCE', { overridePreferenceValue: false }
    );
  }

  return new Promise(resolve => {
    Autodesk.Viewing.Initializer({
      env: 'AutodeskProduction2',
      api: 'streamingV2',
      getAccessToken: (cb) => cb(token.access_token, token.expires_in)
    }, resolve);
  });
}

export function resolveLmvRendererClass() {
  const div = document.createElement('div');
  div.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden';
  document.body.appendChild(div);

  const temp = new Autodesk.Viewing.Viewer3D(div);
  temp.start();
  const RendererClass = temp.impl.glrenderer().constructor;
  temp.finish();
  document.body.removeChild(div);

  return RendererClass;
}

export function createSharedLmvRenderer(RendererClass, canvas) {
  const renderer = new RendererClass({ canvas });
  renderer.autoClear = false;
  renderer.sortObjects = false;
  renderer.refCount = 0;

  // MapLibre clamps the canvas backing store to its maxCanvasSize (4096 by
  // default) by lowering the *applied* pixel ratio once clientWidth×DPR
  // exceeds it. So device px ≠ CSS px × devicePixelRatio past that clamp.
  // Force LMV's pixel ratio to the ratio MapLibre actually applied
  // (canvas.width / clientWidth), or LMV and MapLibre end up rendering
  // into different pixel spaces and camera sync breaks. Note: LMV's
  // setViewport/setSize take CSS px and apply the pixel ratio internally.
  const deviceRatio = () => (canvas.clientWidth ? canvas.width / canvas.clientWidth : 1) || 1;

  const origSetPixelRatio = renderer.setPixelRatio.bind(renderer);
  renderer.setPixelRatio = function() {
    origSetPixelRatio(deviceRatio());
  };

  renderer.setSize = function() {
    renderer.setViewport(0, 0, canvas.clientWidth, canvas.clientHeight);
  };

  return renderer;
}

/**
 * Make LMV's background transparent and enable alpha blending on the
 * final blit (presentBuffer) so MapLibre's map shows through.
 */
export function configureTransparentLmvRendering(viewer) {
  const THREE = window.THREE;
  const rc = viewer.impl.renderer();
  const glr = viewer.impl.glrenderer();
  const gl = glr.getContext();

  rc.setClearColors(new THREE.Color(0, 0, 0));
  rc.setClearAlpha(0);
  viewer.impl.toggleEnvMapBackground(false);
  rc.setAOEnabled(false);

  let forceBlend = false;
  const origDisable = gl.disable.bind(gl);
  gl.disable = function(cap) {
    if (forceBlend && cap === gl.BLEND) return;
    origDisable(cap);
  };

  const canvasMultisampled = !!gl.getContextAttributes().antialias;
  if (canvasMultisampled) {
    console.warn(
      '[LMV] Canvas has antialias enabled (multisampled default framebuffer). ' +
      'Depth blit from LMV FBOs is disabled to avoid GL_INVALID_OPERATION.'
    );
  }

  const origPresent = rc.presentBuffer.bind(rc);
  rc.presentBuffer = function(userFinalPass) {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    forceBlend = true;
    origPresent(userFinalPass);
    forceBlend = false;

    if (canvasMultisampled) return;

    const colorTarget = rc.getColorTarget();
    if (colorTarget) {
      glr.setRenderTarget(colorTarget);
      glr.setRenderTarget(null);

      const fbo = colorTarget.__webglFramebuffer;
      if (fbo) {
        const w = colorTarget.width;
        const h = colorTarget.height;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
        gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      }
    }
  };
}

export function createStoppedLmvViewer(container, glrenderer, mapCanvas) {
  const viewer = new Autodesk.Viewing.GuiViewer3D(container);
  viewer.start(null, null, null, null, { glrenderer });

  viewer.impl.stop();
  viewer.impl.skipCameraUpdate = true;

  const w = mapCanvas.clientWidth;
  const h = mapCanvas.clientHeight;
  viewer.impl.resize(w, h, true);

  configureTransparentLmvRendering(viewer);

  return viewer;
}

export function loadLmvModel(viewer, urn) {
  return new Promise(resolve => {
    Autodesk.Viewing.Document.load(`urn:${urn}`, doc => {
      const viewable = doc.getRoot().getDefaultGeometry();

      // Attach BEFORE loadDocumentNode: MODEL_ADDED_EVENT can fire
      // synchronously during the call. Note: GEOMETRY_LOADED_EVENT no
      // longer fires reliably on LMV >= 7.124 when the viewer is driven
      // manually (impl.stop + external tick), so MODEL_ADDED is our signal.
      viewer.addEventListener(
        Autodesk.Viewing.MODEL_ADDED_EVENT,
        function onAdded() {
          viewer.removeEventListener(Autodesk.Viewing.MODEL_ADDED_EVENT, onAdded);
          resolve(viewer);
        }
      );

      viewer.loadDocumentNode(doc, viewable);
    });
  });
}
