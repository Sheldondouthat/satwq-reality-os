import * as Cesium from 'cesium';

/**
 * Build a keyless WMTS/XYZ-style tile-imagery layer on
 * Cesium.UrlTemplateImageryProvider.
 *
 * The snapshot source owns the exact URL template (dates, frame paths, host);
 * the layer only rebuilds the provider when the template actually changes.
 * A failing/unavailable source leaves the layer detached with `getStats().error`
 * set — never fake tiles.
 *
 * Snapshot shape (from `source.getSnapshot`): `{ template, maximumLevel?,
 * credit?, timeMs? }`. When the snapshot omits `template`, the static
 * `urlTemplate` passed to the factory is used.
 */
export function createImageryTileLayer({
  id,
  name,
  icon,
  source,
  sourceLabel,
  credit,
  urlTemplate = null,
  maximumLevel = 8,
  opacity = 0.85,
  updateInterval,
  getSnapshotOverride,
} = {}) {
  if (!id || typeof id !== 'string')
    throw new TypeError('Imagery tile layer requires an id');
  if (!name || typeof name !== 'string')
    throw new TypeError('Imagery tile layer requires a name');
  const resolveSnapshot =
    typeof getSnapshotOverride === 'function'
      ? getSnapshotOverride
      : typeof source?.getSnapshot === 'function'
        ? (options) => source.getSnapshot(options)
        : null;
  if (!resolveSnapshot)
    throw new TypeError(
      `${id}: requires a snapshot source (source.getSnapshot or getSnapshotOverride)`,
    );
  if (!Number.isFinite(updateInterval) || updateInterval <= 0)
    throw new TypeError(
      `${id}: updateInterval must be a positive number of milliseconds`,
    );

  let _viewer = null;
  let _imageryLayer = null;
  let _template = null;
  let _enabled = false;
  let _request = null;
  let _frames = 0;
  let _updatedAt = null;
  let _lastError = null;

  function detach() {
    if (_viewer && _imageryLayer) {
      try {
        _viewer.imageryLayers.remove(_imageryLayer);
      } catch {
        /* removal is best effort */
      }
    }
    _imageryLayer = null;
    _template = null;
  }

  function attach(template, snapshot) {
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: template,
      maximumLevel:
        Number.isFinite(snapshot?.maximumLevel)
          ? snapshot.maximumLevel
          : maximumLevel,
      credit: snapshot?.credit ?? credit,
    });
    const imageryLayer = _viewer.imageryLayers.addImageryProvider(provider);
    imageryLayer.alpha = opacity;
    _imageryLayer = imageryLayer;
    _template = template;
  }

  const layer = {
    id,
    name,
    icon,
    source: sourceLabel || id,
    updateInterval,

    init(viewer) {
      if (_viewer) throw new Error(`${id}: layer is already initialized`);
      if (!viewer?.imageryLayers)
        throw new TypeError(`${id}: viewer needs imageryLayers`);
      _viewer = viewer;
      _enabled = false;
      _frames = 0;
      _updatedAt = null;
      _lastError = null;
      console.log(`[Data:${name}] Initialized`);
    },

    enable(viewer = _viewer) {
      if (!_viewer) throw new Error(`${id}: enable before init`);
      _enabled = true;
      // A static template can attach immediately; a dynamic one (RainViewer)
      // attaches once the first snapshot resolves below.
      if (urlTemplate && !_imageryLayer) attach(urlTemplate, null);
      void layer.update(_viewer);
    },

    disable(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      detach();
    },

    async update(viewer = _viewer) {
      if (!_enabled || !_viewer) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await resolveSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        const template =
          (snapshot && typeof snapshot.template === 'string'
            ? snapshot.template
            : null) || urlTemplate;
        if (!template || typeof template !== 'string')
          throw new Error(`${id}: snapshot produced no URL template`);
        if (template !== _template) {
          detach();
          attach(template, snapshot);
        }
        _frames += 1;
        _updatedAt = Date.now();
        _lastError = null;
        console.log(`[Data:${name}] Updated (frame ${_frames})`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn(`[Data:${name}] Fetch error:`, e);
        _lastError = e?.message || `${name} source unavailable`;
        // Degrade to off on failure rather than showing stale tiles as live.
        detach();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      detach();
      _viewer = null;
      _frames = 0;
      _updatedAt = null;
      _lastError = null;
    },

    getStats() {
      return { frames: _frames, updatedAt: _updatedAt, error: _lastError };
    },
  };
  return layer;
}
