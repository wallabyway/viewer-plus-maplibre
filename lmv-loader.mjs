const APS_API = 'https://aps-extensions.autodesk.io/api';
const API_BASE = import.meta.env.DEV
  ? '/api'
  : `https://corsproxy.io/?url=${encodeURIComponent(APS_API)}`;

const getToken = () => fetch(`${API_BASE}/auth/token`).then(r => r.json());

export const getModels = () =>
  fetch(`${API_BASE}/models/buckets?id=samplemodels`)
    .then(r => r.json())
    .then(items => items.map(m => ({ name: m.text, urn: m.id })));

export async function initLMV() {
  const token = await getToken();
  return new Promise(resolve => {
    Autodesk.Viewing.Initializer({
      env: 'AutodeskProduction2',
      api: 'streamingV2',
      getAccessToken: (cb) => cb(token.access_token, token.expires_in)
    }, resolve);
  });
}

export function bootstrapRendererClass() {
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

export function createSharedRenderer(RendererClass, canvas) {
  const renderer = new RendererClass({ canvas });
  renderer.autoClear = false;
  renderer.sortObjects = false;
  renderer.refCount = 0;

  renderer.setSize = function() {
    renderer.setViewport(0, 0, canvas.clientWidth, canvas.clientHeight);
  };

  return renderer;
}

/**
 * Make LMV's background transparent and enable alpha blending on the
 * final blit (presentBuffer) so MapLibre's map shows through.
 */
export function patchForTransparency(viewer) {
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

export function createViewer(container, glrenderer, mapCanvas) {
  const viewer = new Autodesk.Viewing.GuiViewer3D(container);
  viewer.start(null, null, null, null, { glrenderer });

  viewer.impl.stop();
  viewer.impl.skipCameraUpdate = true;

  const w = mapCanvas.clientWidth;
  const h = mapCanvas.clientHeight;
  viewer.impl.resize(w, h, true);

  patchForTransparency(viewer);

  return viewer;
}

export function loadModel(viewer, urn) {
  return new Promise(resolve => {
    Autodesk.Viewing.Document.load(`urn:${urn}`, doc => {
      const viewable = doc.getRoot().getDefaultGeometry();
      viewer.loadDocumentNode(doc, viewable);

      viewer.addEventListener(
        Autodesk.Viewing.GEOMETRY_LOADED_EVENT,
        function onLoaded() {
          viewer.removeEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, onLoaded);
          resolve(viewer);
        }
      );
    });
  });
}
