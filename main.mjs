import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  initLMV, bootstrapRendererClass, createSharedRenderer,
  createViewer, loadModel, getModels
} from './lmv-loader.mjs';

const DEFAULT_URN = 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6c2FtcGxlbW9kZWxzL09mZmljZS5ydnQ=';

const THREE = window.THREE;
const FEET_TO_METERS = 0.3048;

/** 4×4 matrix multiply in Float64 (column-major). */
function mulMat4Float64(a, b) {
  const r = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      r[row + col * 4] =
        a[row]     * b[col * 4]     +
        a[row + 4] * b[col * 4 + 1] +
        a[row + 8] * b[col * 4 + 2] +
        a[row + 12] * b[col * 4 + 3];
    }
  }
  return r;
}

// ── Geographic placement (Brownsville, PA) ───────────────────

const modelOrigin = [-79.88666527, 40.022371938];
const modelAltitude = 10;
const modelRotationDeg = 30;

const modelAsMercatorCoordinate = maplibregl.MercatorCoordinate.fromLngLat(
  modelOrigin, modelAltitude
);

const metersPerUnit = FEET_TO_METERS;
const rotRad = (modelRotationDeg * Math.PI) / 180;
const cosR = Math.cos(rotRad);
const sinR = Math.sin(rotRad);
const mercatorScale = modelAsMercatorCoordinate.meterInMercatorCoordinateUnits() * metersPerUnit;

let lmvViewer = null;
let lmvReady = false;
let frameCount = 0;

/** Clean up WebGL2 state that R71's resetGLState doesn't touch. */
function restoreGLStateForMapLibre(gl, glr) {
  glr.resetGLState();
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

const statusEl = document.getElementById('status');
const setStatus = (msg) => { statusEl.textContent = msg; };

// ── Model picker ──────────────────────────────────────────────

async function populateDropdown() {
  const select = document.getElementById('modelSelect');
  const models = await getModels();

  select.innerHTML = '<option value="">Choose a model</option>';
  models.forEach(({ name, urn }) => {
    const opt = document.createElement('option');
    opt.value = urn;
    opt.textContent = name;
    if (urn === DEFAULT_URN) opt.selected = true;
    select.appendChild(opt);
  });

  if (!models.some(m => m.urn === DEFAULT_URN)) {
    const opt = document.createElement('option');
    opt.value = DEFAULT_URN;
    opt.textContent = 'Office.rvt';
    opt.selected = true;
    select.appendChild(opt);
  }

  select.addEventListener('change', (e) => {
    if (e.target.value) switchModel(e.target.value);
  });

  return select.value || DEFAULT_URN;
}

async function switchModel(urn) {
  lmvReady = false;
  setStatus('Loading model...');
  await loadModel(lmvViewer, urn);
  lmvReady = true;
  frameCount = 0;
  setStatus('Model loaded');

  const model = lmvViewer.model;
  if (model) {
    const offset = model.getGlobalOffset?.();
    const bbox = model.getBoundingBox();
    const data = model.getData?.();
    console.log('[LMV model] globalOffset:', offset);
    console.log('[LMV model] placementTransform:', data?.placementTransform);
    console.log('[LMV model] bounds:', bbox);
    console.log('[LMV model] unit scale (ft→m):', metersPerUnit);
  }

  map.triggerRepaint();
}

// ── Custom MapLibre layer ─────────────────────────────────────

const customLayer = {
  id: 'lmv-model',
  type: 'custom',
  renderingMode: '3d',

  onAdd(mapInstance, gl) {
    this.map = mapInstance;
    this.gl = gl;
    this.initAndLoad();
  },

  async initAndLoad() {
    setStatus('Initializing LMV...');
    await initLMV();

    setStatus('Bootstrapping renderer...');
    const LMVRendererClass = bootstrapRendererClass();
    const sharedRenderer = createSharedRenderer(LMVRendererClass, this.map.getCanvas());

    const container = document.getElementById('lmv-hidden');
    const mapCanvas = this.map.getCanvas();
    lmvViewer = createViewer(container, sharedRenderer, mapCanvas);
    lmvViewer.setGhosting(false);
    lmvViewer.setGroundShadow(false);
    lmvViewer.setLightPreset(1);
    lmvViewer.impl.renderer().setAOEnabled(false);

    console.log('[LMV] Shared GL context same as MapLibre?',
      this.gl === lmvViewer.impl.glrenderer().getContext());

    const initialUrn = await populateDropdown();
    await switchModel(initialUrn);
  },

  render(gl, args) {
    if (lmvViewer && !lmvReady) {
      lmvViewer.impl.tick(performance.now());
      restoreGLStateForMapLibre(gl, lmvViewer.impl.glrenderer());
      this.map.triggerRepaint();
      return;
    }

    if (!lmvReady || !lmvViewer) return;

    frameCount++;

    const glr = lmvViewer.impl.glrenderer();
    const c = this.map.getCanvas();
    const s = mercatorScale;

    // RTE: compute model position relative to camera center.
    // This keeps translation values tiny so Float32 stays precise.
    const camCenter = this.map.getCenter();
    const camMerc = maplibregl.MercatorCoordinate.fromLngLat(camCenter, 0);

    const dx = modelAsMercatorCoordinate.x - camMerc.x;
    const dy = modelAsMercatorCoordinate.y - camMerc.y;
    const dz = modelAsMercatorCoordinate.z - (camMerc.z || 0);

    // VP re-centered: translate VP so its origin is the camera center.
    // vpCentered = VP × T(camMerc), then model uses relative coords.
    const vp64 = args.defaultProjectionData.mainMatrix;
    const camTranslate = new Float64Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      camMerc.x, camMerc.y, camMerc.z || 0, 1
    ]);
    const vpCentered = mulMat4Float64(vp64, camTranslate);

    const model64 = new Float64Array([
       s * cosR, -s * sinR, 0, 0,
      -s * sinR, -s * cosR, 0, 0,
       0,         0,        s, 0,
       dx,        dy,       dz, 1
    ]);

    const result = mulMat4Float64(vpCentered, model64);

    const cam = lmvViewer.impl.camera;
    cam.projectionMatrix.elements.set(new Float32Array(result));

    cam.position.set(0, 0, 0);
    if (cam.quaternion) cam.quaternion.set(0, 0, 0, 1);
    if (cam.rotation) cam.rotation.set(0, 0, 0);
    cam.scale.set(1, 1, 1);
    cam.matrixWorld.identity();
    cam.matrixWorldInverse.identity();

    glr.resetGLState();
    glr.setViewport(0, 0, c.clientWidth, c.clientHeight);

    lmvViewer.impl.invalidate(true, true, true);
    lmvViewer.impl.tick(performance.now());

    restoreGLStateForMapLibre(gl, glr);
  }
};

// ── Map setup ─────────────────────────────────────────────────

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/bright',
  zoom: 18,
  center: modelOrigin,
  pitch: 60,
  maxPitch: 85,
  canvasContextAttributes: { antialias: true }
});

map.addControl(new maplibregl.NavigationControl({
  visualizePitch: true,
  showZoom: true,
  showCompass: true
}));

map.on('style.load', () => {
  for (const layer of map.getStyle().layers) {
    if (layer.type === 'symbol') map.removeLayer(layer.id);
  }

  // Terrain DEM + hillshade (Mapterhorn)
  // map.addSource('terrainSource', {
  //   type: 'raster-dem',
  //   url: 'https://tiles.mapterhorn.com/tilejson.json',
  //   tileSize: 256
  // });

  map.addSource('hillshadeSource', {
    type: 'raster-dem',
    url: 'https://tiles.mapterhorn.com/tilejson.json',
    tileSize: 256
  });


  map.addLayer({
    id: 'hills',
    type: 'hillshade',
    source: 'hillshadeSource',
    paint: { 'hillshade-shadow-color': '#473B24' }
  });

//  map.setTerrain({ source: 'terrainSource', exaggeration: 1.4 });
  map.setSky({});

  map.addLayer(customLayer);

  map.addLayer({
    id: '3d-buildings',
    source: 'openmaptiles',
    'source-layer': 'building',
    type: 'fill-extrusion',
    minzoom: 15,
    paint: {
      'fill-extrusion-color': '#aaa',
      'fill-extrusion-height': ['get', 'render_height'],
      'fill-extrusion-base': ['get', 'render_min_height'],
      'fill-extrusion-opacity': 0.6
    }
  });
});
