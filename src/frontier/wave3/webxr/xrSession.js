/**
 * WebXR mode — immersive-vr session manager (hand-rolled WebGL, no three.js).
 *
 * Renders the equirect panorama (paintPanorama) as a texture on the INSIDE of
 * a sphere with the camera at the center — a genuine stereo "step inside the
 * planet" view. Runs on the Quest browser's WebXR implementation; degrades
 * to the 2D fallback viewer when immersive-vr is unavailable.
 *
 * Honest scope notes (v1):
 *  - This is NOT the Cesium globe ported to XR. It's a purpose-built
 *    immersive layer with live data sprites. A full Cesium→XR port is
 *    explicitly out of scope for v1 (labeled as such in the UI).
 *  - No controllers, no locomotion: look-around only (head tracking).
 */
import { xrImmersiveSupported } from './math.js';
import { paintPanorama } from './panorama.js';

const VERT = `
attribute vec3 aPos;
attribute vec2 aUV;
uniform mat4 uView;
uniform mat4 uProj;
varying vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

const FRAG = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUV;
void main() {
  gl_FragColor = texture2D(uTex, vUV);
}`;

/** Build an inverted (inside-out) sphere mesh: positions, uvs, indices. */
export function buildSphereMesh(segments = 48, rings = 32, radius = 10) {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let r = 0; r <= rings; r += 1) {
    const lat = 90 - (r / rings) * 180;
    const phi = ((90 - lat) * Math.PI) / 180;
    const sinPhi = Math.sin(phi);
    const y = Math.cos(phi) * radius;
    for (let s = 0; s <= segments; s += 1) {
      const lon = (s / segments) * 360 - 180;
      const theta = ((lon + 180) * Math.PI) / 180;
      positions.push(
        -sinPhi * Math.cos(theta) * radius,
        y,
        sinPhi * Math.sin(theta) * radius,
      );
      uvs.push(s / segments, r / rings);
    }
  }
  const row = segments + 1;
  for (let r = 0; r < rings; r += 1) {
    for (let s = 0; s < segments; s += 1) {
      const a = r * row + s;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      // Wound so front faces point INWARD (camera sees inside of sphere).
      indices.push(a, c, b, b, c, d);
    }
  }
  return {
    positions: new Float32Array(positions),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`shader compile failed: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

function createProgram(gl) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`);
  }
  return prog;
}

/**
 * Start an immersive-vr session rendering `panoramaCanvas` inside the sphere.
 * Returns { session, stop } — throws when WebXR is unavailable (caller falls
 * back to the 2D viewer).
 */
export async function startImmersiveSession(
  panoramaCanvas,
  { navigatorLike } = {},
) {
  const nav =
    navigatorLike || (typeof navigator !== 'undefined' ? navigator : null);
  const supported = await xrImmersiveSupported(nav);
  if (!supported) throw new Error('immersive-vr not supported');
  if (typeof document === 'undefined') throw new Error('no DOM');

  const glCanvas = document.createElement('canvas');
  const gl = glCanvas.getContext('webgl', {
    xrCompatible: true,
    antialias: true,
  });
  if (!gl) throw new Error('WebGL unavailable');

  const session = await nav.xr.requestSession('immersive-vr', {
    optionalFeatures: ['local-floor', 'bounded-floor'],
  });
  await gl.makeXRCompatible();
  session.updateRenderState({
    baseLayer: new XRWebGLLayer(session, gl),
  });

  const prog = createProgram(gl);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  const aUV = gl.getAttribLocation(prog, 'aUV');
  const uView = gl.getUniformLocation(prog, 'uView');
  const uProj = gl.getUniformLocation(prog, 'uProj');
  const uTex = gl.getUniformLocation(prog, 'uTex');

  const mesh = buildSphereMesh();
  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
  const uvBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.STATIC_DRAW);
  const idxBuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

  const tex = gl.createTexture();
  const uploadTexture = () => {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      panoramaCanvas,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };
  uploadTexture();

  const refSpace = await session.requestReferenceSpace('local');
  let stopped = false;

  session.addEventListener('end', () => {
    stopped = true;
  });

  const onFrame = (time, frame) => {
    if (stopped) return;
    session.requestAnimationFrame(onFrame);
    const layer = session.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0.0, 0.0, 0.02, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE); // winding already faces inward; render both to be safe

    const pose = frame.getViewerPose(refSpace);
    if (!pose) return;

    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(uTex, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);

    for (const view of pose.views) {
      const vp = layer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      gl.uniformMatrix4fv(uView, false, view.transform.inverse.matrix);
      gl.uniformMatrix4fv(uProj, false, view.projectionMatrix);
      gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0);
    }
  };
  session.requestAnimationFrame(onFrame);

  return {
    session,
    /** Re-upload the panorama texture after a repaint. */
    refreshTexture: uploadTexture,
    stop: async () => {
      stopped = true;
      try {
        await session.end();
      } catch {
        /* already ended */
      }
    },
  };
}

/** Repaint loop helper: repaint the panorama every `intervalMs`, calling onRepaint. */
export function startPanoramaRefresh(
  getSprites,
  onRepaint,
  intervalMs = 30000,
) {
  let stopped = false;
  let canvas = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const sprites = await getSprites();
      canvas = paintPanorama(sprites, canvas);
      if (canvas && onRepaint) onRepaint(canvas);
    } catch {
      /* fail-soft */
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  let timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
