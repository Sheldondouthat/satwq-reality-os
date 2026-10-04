/**
 * F10 notebook panel — small DOM component for the planetary notebook.
 *
 * Responsibilities: pin list (edit/delete/focus), add-pin-at-map-center,
 * optional click-to-add hook, JSON export/import, and Cesium pin entities
 * that survive reload (storage owns persistence; entities are re-rendered
 * from the notebook on attach).
 *
 * Framework-free; mount into any container element. Wiring in INTEGRATION.md.
 */
import * as Cesium from 'cesium';

const PIN_ID_PREFIX = 'notebook-pin:';
const PIN_COLOR = '#ffd166';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function pinEntity(pin, { cesium = Cesium } = {}) {
  return new cesium.Entity({
    id: `${PIN_ID_PREFIX}${pin.id}`,
    position: cesium.Cartesian3.fromDegrees(pin.lon, pin.lat),
    point: {
      pixelSize: 10,
      color: new cesium.ConstantProperty(
        cesium.Color.fromCssColorString(PIN_COLOR),
      ),
      outlineColor: cesium.Color.BLACK,
      outlineWidth: 2,
      heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
    },
    label: {
      text: `📍 ${pin.title}`,
      font: '12px sans-serif',
      fillColor: cesium.Color.WHITE,
      outlineColor: cesium.Color.BLACK,
      outlineWidth: 2,
      style: cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new cesium.Cartesian2(0, -18),
      showBackground: true,
      backgroundColor: cesium.Color.BLACK.withAlpha(0.5),
      heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
    },
    description: pin.body || '(no notes)',
  });
}

export function createNotebookPanel({
  notebook,
  cesium = Cesium,
  screenSpaceEventHandlerFactory = (viewer) =>
    new cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
} = {}) {
  if (!notebook) throw new TypeError('notebookPanel requires a notebook');
  let _viewer = null;
  let _dataSource = null;
  let _container = null;
  let _clickHandler = null;
  let _clickToAdd = false;
  let _selectedId = null;
  let _unsubscribe = null;

  const syncEntities = () => {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    for (const pin of notebook.list()) {
      _dataSource.entities.add(pinEntity(pin, { cesium }));
    }
  };

  function mapCenterLatLon() {
    if (!_viewer) return null;
    const { camera } = _viewer;
    const carto = cesium.Ellipsoid.WGS84.cartesianToCartographic(
      camera.positionWC,
    );
    if (!carto) return null;
    return {
      lat: (carto.latitude * 180) / Math.PI,
      lon: (carto.longitude * 180) / Math.PI,
    };
  }

  function flyTo(pin) {
    if (!_viewer) return;
    _viewer.camera.flyTo({
      destination: cesium.Cartesian3.fromDegrees(pin.lon, pin.lat, 500_000),
      duration: 1.2,
    });
  }

  function addPinAtCenter() {
    const center = mapCenterLatLon();
    if (!center) return null;
    const pin = notebook.add({
      lat: center.lat,
      lon: center.lon,
      title: 'New note',
      body: '',
    });
    _selectedId = pin.id;
    render();
    return pin;
  }

  function render() {
    if (!_container) return;
    _container.innerHTML = '';
    const root = el('div', 'notebook-panel');
    root.appendChild(el('h3', null, '📍 Planetary Notebook'));

    const info = notebook.getStorageInfo();
    const badge = el(
      'p',
      'notebook-storage',
      `${notebook.list().length} pin(s) · ${info.kind}${
        info.persistent === false ? ' (not persistent)' : ''
      }`,
    );
    root.appendChild(badge);

    const toolbar = el('div', 'notebook-toolbar');
    const addBtn = el('button', null, '＋ Add pin at map center');
    addBtn.addEventListener('click', addPinAtCenter);
    const clickBtn = el(
      'button',
      null,
      _clickToAdd ? '✖ Click-to-add: ON' : '＋ Click-to-add: OFF',
    );
    clickBtn.addEventListener('click', () => {
      _clickToAdd = !_clickToAdd;
      render();
    });
    const exportBtn = el('button', null, '⬇ Export JSON');
    exportBtn.addEventListener('click', () => {
      const blob = new Blob([notebook.exportJSON()], {
        type: 'application/json',
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `planetary-notebook-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    const importLabel = el('label', 'notebook-import', '⬆ Import JSON');
    const importInput = el('input');
    importInput.type = 'file';
    importInput.accept = 'application/json,.json';
    importInput.hidden = true;
    importInput.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        const result = notebook.importJSON(await file.text());
        badge.textContent = `Imported ${result.imported}, skipped ${result.skipped}.`;
      } catch (e) {
        badge.textContent = `Import failed: ${e.message}`;
      }
      render();
    });
    importLabel.appendChild(importInput);
    toolbar.append(addBtn, clickBtn, exportBtn, importLabel);
    root.appendChild(toolbar);

    const list = el('ul', 'notebook-list');
    for (const pin of notebook.list()) {
      const item = el(
        'li',
        `notebook-item${pin.id === _selectedId ? ' selected' : ''}`,
      );
      const head = el('div', 'notebook-head');
      head.appendChild(el('strong', null, pin.title));
      head.appendChild(
        el(
          'span',
          'notebook-coords',
          `${pin.lat.toFixed(3)}, ${pin.lon.toFixed(3)}`,
        ),
      );
      item.appendChild(head);
      if (pin.body) item.appendChild(el('p', 'notebook-body', pin.body));

      const actions = el('div', 'notebook-actions');
      const focus = el('button', null, 'Focus');
      focus.addEventListener('click', () => flyTo(pin));
      const edit = el(
        'button',
        null,
        _selectedId === pin.id ? 'Close' : 'Edit',
      );
      edit.addEventListener('click', () => {
        _selectedId = _selectedId === pin.id ? null : pin.id;
        render();
      });
      const del = el('button', null, 'Delete');
      del.addEventListener('click', () => {
        if (notebook.remove(pin.id) && _selectedId === pin.id)
          _selectedId = null;
        render();
      });
      actions.append(focus, edit, del);
      item.appendChild(actions);

      if (_selectedId === pin.id) {
        const form = el('div', 'notebook-form');
        const titleInput = el('input');
        titleInput.value = pin.title;
        titleInput.placeholder = 'Title';
        titleInput.maxLength = 140;
        const bodyInput = el('textarea');
        bodyInput.value = pin.body;
        bodyInput.placeholder = 'Notes…';
        bodyInput.rows = 3;
        const save = el('button', null, 'Save');
        save.addEventListener('click', () => {
          notebook.update(pin.id, {
            title: titleInput.value,
            body: bodyInput.value,
          });
          _selectedId = null;
          render();
        });
        form.append(titleInput, bodyInput, save);
        item.appendChild(form);
      }
      list.appendChild(item);
    }
    root.appendChild(list);
    _container.appendChild(root);
  }

  function installClickHandler() {
    if (_clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (!_clickToAdd || !click?.position) return;
      const cartesian = _viewer.camera.pickEllipsoid(
        click.position,
        cesium.Ellipsoid.WGS84,
      );
      if (!cartesian) return;
      const carto = cesium.Ellipsoid.WGS84.cartesianToCartographic(cartesian);
      const pin = notebook.add({
        lat: (carto.latitude * 180) / Math.PI,
        lon: (carto.longitude * 180) / Math.PI,
        title: 'New note',
        body: '',
      });
      _selectedId = pin.id;
      render();
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  const panel = {
    mount(container) {
      _container = container;
      _unsubscribe = notebook.onChange(() => {
        syncEntities();
        render();
      });
      render();
      return panel;
    },

    attachViewer(viewer) {
      _viewer = viewer;
      _dataSource = new cesium.CustomDataSource('planetary-notebook');
      viewer.dataSources.add(_dataSource);
      syncEntities();
      installClickHandler();
      return panel;
    },

    addPinAtCenter,
    refresh: () => {
      syncEntities();
      render();
    },
    get selectedId() {
      return _selectedId;
    },

    unmount() {
      _unsubscribe?.();
      _unsubscribe = null;
      if (_clickHandler) {
        _clickHandler.destroy();
        _clickHandler = null;
      }
      if (_dataSource && _viewer) {
        _viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      if (_container) _container.innerHTML = '';
      _container = null;
    },
  };
  return panel;
}
