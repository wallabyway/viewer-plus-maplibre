import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { fetchModelCatalog } from './lmv-loader.mjs';
import { createLmvBridge, createMercatorModelPlacement } from './lmv-maplibre-bridge.mjs';

const DEFAULT_URN = 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6c2FtcGxlbW9kZWxzL09mZmljZS5ydnQ=';
const MODEL_ORIGIN = [-79.88666527, 40.022371938];

const modelPlacement = createMercatorModelPlacement({
  origin: MODEL_ORIGIN,
  altitude: 10,
  rotationDeg: 30,
  unitScale: 0.3048
});

const statusElement = document.getElementById('status');

function setStatus(message) {
  statusElement.textContent = message;
}

async function populateModelSelector(onModelSelected) {
  const selector = document.getElementById('modelSelect');
  const models = await fetchModelCatalog();

  selector.innerHTML = '<option value="">Choose a model</option>';
  models.forEach(({ name, urn }) => {
    const option = document.createElement('option');
    option.value = urn;
    option.textContent = name;
    option.selected = urn === DEFAULT_URN;
    selector.appendChild(option);
  });

  if (!models.some(model => model.urn === DEFAULT_URN)) {
    const option = document.createElement('option');
    option.value = DEFAULT_URN;
    option.textContent = 'Office.rvt';
    option.selected = true;
    selector.appendChild(option);
  }

  selector.addEventListener('change', event => {
    if (event.target.value) {
      void onModelSelected(event.target.value).catch(console.error);
    }
  });

  return selector.value || DEFAULT_URN;
}

function createMap() {
  const map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/bright',
    zoom: 18,
    center: modelPlacement.origin,
    pitch: 60,
    maxPitch: 85,
    canvasContextAttributes: { antialias: true }
  });

  map.addControl(new maplibregl.NavigationControl({
    visualizePitch: true,
    showZoom: true,
    showCompass: true
  }));

  return map;
}

function addMapStyleLayers(map, lmvLayer) {
  for (const layer of map.getStyle().layers) {
    if (layer.type === 'symbol') map.removeLayer(layer.id);
  }

  // Terrain DEM + hillshade (Mapterhorn).
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

  map.setSky({});
  map.addLayer(lmvLayer);

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
}

async function initializeModelFlow(bridge) {
  const initialUrn = await populateModelSelector(urn => bridge.loadModel(urn));
  await bridge.loadModel(initialUrn);
}

function startApplication() {
  const map = createMap();
  const bridge = createLmvBridge({
    container: document.getElementById('lmv-hidden'),
    modelPlacement,
    onStatus: setStatus
  });

  // Debug hooks retained for the existing browser probes.
  window.__map = map;
  window.__lmvBridge = bridge;

  map.on('style.load', () => {
    addMapStyleLayers(map, bridge.layer);
    void initializeModelFlow(bridge).catch(error => {
      console.error('[LMV] Initialization failed', error);
      setStatus('LMV initialization failed');
    });
  });
}

startApplication();
