(() => {
  // src/shared/protocol.ts
  var asRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  var describeError = (error) => {
    if (error instanceof Error) {
      const message = error.message === "" ? "" : `: ${error.message}`;
      return `${error.name}${message}`;
    }
    return String(error);
  };
  var round1 = (value) => Math.round(value * 10) / 10;
  var formatMs = (value) => value >= 1000 ? `${(value / 1000).toFixed(2)}秒` : `${Math.round(value)}ms`;
  var formatBytes = (value) => {
    if (value >= 1024 * 1024)
      return `${(value / (1024 * 1024)).toFixed(2)}MB`;
    if (value >= 1024)
      return `${(value / 1024).toFixed(1)}KB`;
    return `${value}B`;
  };

  // src/shared/rpc.ts
  var REQUEST = "rpc-request";
  var RESPONSE = "rpc-response";
  var createRpc = (port, handler) => {
    const pending = new Map;
    let nextId = 1;
    const respond = async (id, method, params) => {
      if (handler === undefined) {
        port.postMessage({ kind: RESPONSE, id, ok: false, error: `知らない操作: ${method}` });
        return;
      }
      try {
        const data = await handler(method, params);
        port.postMessage({ kind: RESPONSE, id, ok: true, data });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        port.postMessage({ kind: RESPONSE, id, ok: false, error: message });
      }
    };
    const onMessage = (event) => {
      const data = asRecord(event.data);
      if (data === undefined)
        return;
      const { kind, id } = data;
      if (typeof id !== "number" || !Number.isInteger(id))
        return;
      if (kind === RESPONSE) {
        const entry = pending.get(id);
        if (entry === undefined)
          return;
        pending.delete(id);
        clearTimeout(entry.timer);
        if (data.ok === true)
          entry.resolve(data.data);
        else
          entry.reject(new Error(typeof data.error === "string" ? data.error : "枠で失敗した"));
        return;
      }
      if (kind === REQUEST && typeof data.method === "string") {
        respond(id, data.method, data.params);
      }
    };
    port.addEventListener("message", onMessage);
    port.start();
    const call = (method, params, timeoutMs) => new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`枠からの返事が時間切れ（${method}）`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      port.postMessage({ kind: REQUEST, id, method, params });
    });
    const close = () => {
      port.removeEventListener("message", onMessage);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("枠を閉じた"));
      }
      pending.clear();
      port.close();
    };
    return { call, close };
  };

  // src/shared/module-graph.ts
  var specifierPatterns = () => [
    /(\bfrom\s*)(["'])((?:room|lib):[^"'\s]+)\2/g,
    /(\bimport\s*\(\s*)(["'])((?:room|lib):[^"'\s]+)\2/g,
    /(\bimport\s+)(["'])((?:room|lib):[^"'\s]+)\2/g
  ];
  var NAME_PATTERN = /^(?:room|lib):(.+)$/;
  var targetOf = (specifier) => NAME_PATTERN.exec(specifier)?.[1];
  var dependenciesOf = (source) => {
    const specifiers = [];
    for (const pattern of specifierPatterns()) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[3];
        if (specifier !== undefined && !specifiers.includes(specifier))
          specifiers.push(specifier);
      }
    }
    return specifiers;
  };
  var rewriteSpecifiers = (source, urls) => {
    let rewritten = source;
    for (const pattern of specifierPatterns()) {
      rewritten = rewritten.replace(pattern, (whole, prefix, _quote, specifier) => {
        const target = targetOf(specifier);
        const url = target === undefined ? undefined : urls[target];
        return url === undefined ? whole : `${prefix}${JSON.stringify(url)}`;
      });
    }
    return rewritten;
  };
  var visit = (visitState, name) => {
    const current = visitState.state.get(name);
    if (current === "done")
      return;
    if (current === "visiting") {
      const start = visitState.stack.indexOf(name);
      return [...visitState.stack.slice(start), name];
    }
    visitState.state.set(name, "visiting");
    visitState.stack.push(name);
    const module = visitState.byName.get(name);
    if (module !== undefined) {
      for (const specifier of dependenciesOf(module.source)) {
        const dependency = targetOf(specifier);
        if (dependency === undefined || !visitState.byName.has(dependency))
          continue;
        const cycle = visit(visitState, dependency);
        if (cycle !== undefined)
          return cycle;
      }
    }
    visitState.stack.pop();
    visitState.state.set(name, "done");
    visitState.order.push(name);
    return;
  };
  var orderModules = (modules) => {
    const visitState = {
      byName: new Map(modules.map((module) => [module.name, module])),
      state: new Map,
      stack: [],
      order: []
    };
    for (const module of modules) {
      const cycle = visit(visitState, module.name);
      if (cycle !== undefined)
        return { kind: "cycle", cycle };
    }
    return { kind: "ordered", order: visitState.order };
  };

  // src/frame/params.ts
  var parseModules = (value) => {
    if (!Array.isArray(value))
      return;
    const modules = [];
    for (const item of value) {
      const record = asRecord(item);
      if (record === undefined)
        return;
      const name = record.name;
      const source = record.source;
      if (typeof name !== "string" || name === "")
        return;
      if (typeof source !== "string")
        return;
      modules.push({ name, source });
    }
    return modules;
  };
  var parseEntry = (value) => typeof value === "string" && value !== "" ? value : undefined;
  var parseSource = (value) => typeof value === "string" ? value : undefined;

  // src/frame/spawn.ts
  var buildUrlTable = (modules, order) => {
    const byName = new Map(modules.map((module) => [module.name, module]));
    const urls = {};
    const created = [];
    for (const name of order) {
      const module = byName.get(name);
      if (module === undefined)
        continue;
      const source = rewriteSpecifiers(module.source, urls);
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      urls[name] = url;
      created.push(url);
    }
    return { urls, order, created };
  };
  var createWorker = (source) => {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    return { worker: new Worker(url), url };
  };
  var revokeAll = (urls) => {
    for (const url of urls)
      URL.revokeObjectURL(url);
  };

  // src/frame/wait.ts
  var waitForMessage = (worker, types, timeoutMs) => new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onMessageError);
      resolve(outcome);
    };
    const onMessage = (event) => {
      const data = asRecord(event.data);
      if (data === undefined || typeof data.type !== "string")
        return;
      if (!types.includes(data.type))
        return;
      finish({ kind: "message", type: data.type, data });
    };
    const onError = (event) => {
      const where = event.filename === "" && event.lineno === 0 ? "" : ` at ${event.filename}:${event.lineno}`;
      const inner = event.error instanceof Error ? ` ${event.error.name}: ${event.error.message}` : "";
      finish({
        kind: "error",
        detail: `${event.message || "Worker の error イベント"}${where}${inner}`
      });
    };
    const onMessageError = () => {
      finish({ kind: "error", detail: "Worker から複製できないメッセージが届いた" });
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onMessageError);
  });
  var textField = (data, key) => {
    const value = data[key];
    return typeof value === "string" ? value : "";
  };
  var outcomeDetail = (outcome) => outcome.kind === "error" ? outcome.detail : "時間切れ";

  // src/frame/workers/lockdown.ts
  var LOCK_CODE = `
const describe = (error) => (error && error.name ? error.name + ": " + error.message : String(error));
const hideEntryPoints = () => {
  const records = [];
  const targets = [
    { label: "self.Worker", holder: self, key: "Worker" },
    { label: "self.SharedWorker", holder: self, key: "SharedWorker" },
    { label: "URL.createObjectURL", holder: URL, key: "createObjectURL" },
    { label: "URL.revokeObjectURL", holder: URL, key: "revokeObjectURL" },
    { label: "self.importScripts", holder: self, key: "importScripts" }
  ];
  const protos = [];
  let cursor = Object.getPrototypeOf(self);
  while (cursor !== null) {
    protos.push(cursor);
    cursor = Object.getPrototypeOf(cursor);
  }
  for (const target of targets) {
    const holders = [{ kind: "own", holder: target.holder }];
    for (const proto of protos) {
      if (Object.prototype.hasOwnProperty.call(proto, target.key)) {
        holders.push({ kind: "prototype", holder: proto });
      }
    }
    for (const holder of holders) {
      const before = typeof holder.holder[target.key];
      try {
        delete holder.holder[target.key];
      } catch (error) {
        // 消せない環境でも、記録だけ残す。
      }
      let after = typeof holder.holder[target.key];
      if (after !== "undefined") {
        try {
          Object.defineProperty(holder.holder, target.key, {
            value: undefined,
            writable: false,
            configurable: false
          });
        } catch (error) {
          // 定義できない場合も、記録だけ残す。
        }
        after = typeof holder.holder[target.key];
      }
      records.push(target.label + "=" + after);
    }
  }
  return records;
};
`;

  // src/frame/workers/loader.ts
  var MODULE_LOADER_SOURCE = `${LOCK_CODE}
const toText = (value) => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
};

const boot = async (data) => {
  const urls = data.urls && typeof data.urls === "object" ? data.urls : {};
  const hidden = data.lock === false ? [] : hideEntryPoints();
  if (data.lock !== false) {
    self.__room = {
      use: function (name) {
        return import(urls[name]);
      },
      post: function (value) {
        self.postMessage({ type: "room-post", value: value });
      }
    };
  }
  self.postMessage({ type: "preamble-ready", hidden: hidden });

  const entryUrl = urls[data.entry];
  if (typeof entryUrl !== "string") {
    self.postMessage({ type: "entry-error", detail: "入口の URL が無い: " + String(data.entry) });
    return;
  }
  let namespace;
  try {
    namespace = await import(entryUrl);
  } catch (error) {
    self.postMessage({ type: "entry-error", detail: describe(error) });
    return;
  }

  const values = { result: toText(namespace ? namespace.result : undefined) };
  if (namespace && typeof namespace.run === "function") {
    try {
      values.runtime = toText(await namespace.run());
    } catch (error) {
      values.runtime = "ERROR: " + describe(error);
    }
  }
  self.postMessage({ type: "entry-loaded", values: values });
};

let booted = false;
self.onmessage = (event) => {
  const data = event.data;
  if (!data || data.type !== "boot" || booted) return;
  booted = true;
  boot(data).catch((error) => self.postMessage({ type: "entry-error", detail: describe(error) }));
};
`;
  var WORKER_PROBE_SOURCE = `${LOCK_CODE}
try {
  const hidden = hideEntryPoints();
  self.postMessage({
    type: "worker-env",
    value: {
      origin: String(self.origin),
      worker: typeof Worker,
      offscreenCanvas: typeof OffscreenCanvas,
      requestAnimationFrame: typeof requestAnimationFrame,
      webgl2: typeof WebGL2RenderingContext,
      audioContext: typeof AudioContext,
      rtc: typeof RTCPeerConnection,
      hiddenCount: hidden.length
    }
  });
} catch (error) {
  self.postMessage({ type: "worker-env", value: { error: describe(error) } });
}
`;

  // src/frame/jobs/load.ts
  var LOAD_TIMEOUT_MS = 13000;
  var loadJob = async (params) => {
    const record = asRecord(params);
    if (record === undefined)
      throw new Error("params がオブジェクトでない");
    const modules = parseModules(record.modules);
    const entry = parseEntry(record.entry);
    if (modules === undefined || entry === undefined) {
      throw new Error("modules か entry の形が不正");
    }
    const order = orderModules(modules);
    if (order.kind === "cycle")
      throw new Error(`循環する読み込み: ${order.cycle.join(" → ")}`);
    const table = buildUrlTable(modules, order.order);
    const started = performance.now();
    const { worker, url: loaderUrl } = createWorker(MODULE_LOADER_SOURCE);
    try {
      worker.postMessage({ type: "boot", urls: table.urls, entry, lock: true });
      const outcome = await waitForMessage(worker, ["entry-loaded", "entry-error"], LOAD_TIMEOUT_MS);
      if (outcome.kind === "message" && outcome.type === "entry-loaded") {
        return {
          status: "loaded",
          values: asRecord(outcome.data.values) ?? {},
          order: table.order,
          elapsedMs: round1(performance.now() - started)
        };
      }
      if (outcome.kind === "message") {
        throw new Error(textField(outcome.data, "detail") || "入口の読み込みに失敗");
      }
      throw new Error(outcomeDetail(outcome));
    } finally {
      worker.terminate();
      revokeAll(table.created);
      URL.revokeObjectURL(loaderUrl);
    }
  };

  // src/frame/jobs/probe.ts
  var PROBE_TIMEOUT_MS = 1e4;
  var workerEnvJob = async () => {
    const { worker, url } = createWorker(WORKER_PROBE_SOURCE);
    try {
      const outcome = await waitForMessage(worker, ["worker-env"], PROBE_TIMEOUT_MS);
      if (outcome.kind === "message")
        return asRecord(outcome.data.value) ?? {};
      throw new Error(outcomeDetail(outcome));
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  };

  // src/frame/workers/render.ts
  var RENDER_2D = `
    const canvas = new OffscreenCanvas(64, 64);
    const context = canvas.getContext("2d");
    if (!context) {
      fail("Worker の中に 2D コンテキストが無い");
      return;
    }
    context.fillStyle = "#33aa77";
    context.fillRect(0, 0, 64, 64);
    const pixel = Array.from(context.getImageData(32, 32, 1, 1).data);
    post({
      type: "render-result",
      value: {
        kind: "2d",
        ok: pixel[0] === 51 && pixel[1] === 170 && pixel[2] === 119 && pixel[3] === 255,
        pixel: pixel,
        width: canvas.width,
        height: canvas.height
      }
    });
`;
  var RENDER_WEBGL2 = `
    const canvas = new OffscreenCanvas(64, 64);
    const gl = canvas.getContext("webgl2");
    if (!gl) {
      fail("Worker の中で WebGL2 コンテキストが取れない");
      return;
    }
    gl.clearColor(1, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.finish();
    const raw = new Uint8Array(4);
    gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const pixel = Array.from(raw);
    post({
      type: "render-result",
      value: {
        kind: "webgl2",
        ok: pixel[0] > 200 && pixel[1] < 50 && pixel[2] < 50,
        pixel: pixel,
        version: String(gl.getParameter(gl.VERSION)),
        width: canvas.width,
        height: canvas.height
      }
    });
`;
  var renderProbeSource = (kind) => `${LOCK_CODE}
const post = (message) => self.postMessage(message);
const fail = (detail) => post({ type: "render-error", detail: detail });

const run = () => {
  hideEntryPoints();
  if (typeof OffscreenCanvas === "undefined") {
    fail("Worker の中に OffscreenCanvas が無い");
    return;
  }
${kind === "2d" ? RENDER_2D : RENDER_WEBGL2}};

try {
  run();
} catch (error) {
  self.postMessage({ type: "render-error", detail: describe(error) });
}
`;
  var TRANSFER_2D_SOURCE = `${LOCK_CODE}
let started = false;
const post = (message) => self.postMessage(message);

try {
  hideEntryPoints();
} catch (error) {
  post({ type: "draw-error", detail: describe(error) });
}

self.onmessage = (event) => {
  const data = event.data;
  if (!data || data.type !== "canvas" || started) return;
  started = true;
  const canvas = data.canvas;
  const context = canvas.getContext("2d");
  if (!context) {
    post({ type: "draw-error", detail: "渡されたキャンバスに 2D コンテキストが無い" });
    return;
  }
  const width = canvas.width;
  const height = canvas.height;
  const startedAt = performance.now();
  let frames = 0;
  let reported = false;
  const loop = () => {
    const seconds = (performance.now() - startedAt) / 1000;
    context.fillStyle = "#101820";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "hsl(" + Math.floor((seconds * 180) % 360) + " 80% 55%)";
    const size = 60 + 24 * Math.sin(seconds * 6);
    context.fillRect((width - size) / 2, (height - size) / 2, size, size);
    frames += 1;
    if (!reported && performance.now() - startedAt >= 2000) {
      reported = true;
      post({
        type: "draw-result",
        value: { frames: frames, width: width, height: height, elapsedMs: Math.round(performance.now() - startedAt) }
      });
    }
    // 人が目で見て確かめられるよう、結果を返したあとも描き続ける。
    setTimeout(loop, reported ? 80 : 16);
  };
  loop();
};
`;

  // src/frame/workers/scene.ts
  var THREE_SCENE_SOURCE = `
import * as THREE from "room:three";

const describe = (error) => (error && error.name ? error.name + ": " + error.message : String(error));
let started = false;
const post = (message) => self.postMessage(message);

const readPixel = (gl, x, y) => {
  const pixel = new Uint8Array(4);
  if (gl) gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  return Array.from(pixel);
};

const run = (canvas) => {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, preserveDrawingBuffer: true });
  } catch (error) {
    post({ type: "scene-error", detail: "WebGLRenderer を作れない: " + describe(error) });
    return;
  }
  const width = canvas.width;
  const height = canvas.height;
  renderer.setSize(width, height, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101820);
  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
  camera.position.set(2.2, 2.2, 2.6);
  camera.lookAt(0, 0, 0);
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 1.2, 1.2),
    new THREE.MeshStandardMaterial({ color: 0xff6a2a, roughness: 0.4, metalness: 0.1 })
  );
  scene.add(mesh);
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const light = new THREE.DirectionalLight(0xffffff, 2.4);
  light.position.set(3, 4, 5);
  scene.add(light);

  let gl = null;
  try {
    gl = renderer.getContext();
  } catch (error) {
    gl = null;
  }

  const startedAt = performance.now();
  let frames = 0;
  const loop = () => {
    mesh.rotation.x += 0.06;
    mesh.rotation.y += 0.04;
    renderer.render(scene, camera);
    frames += 1;
    if (performance.now() - startedAt < 3000) {
      setTimeout(loop, 16);
      return;
    }
    if (gl) gl.finish();
    const center = readPixel(gl, Math.floor(width / 2), Math.floor(height / 2));
    const corner = readPixel(gl, 1, 1);
    post({
      type: "scene-result",
      value: {
        frames: frames,
        context: renderer.capabilities.isWebGL2 ? "webgl2" : "webgl",
        version: gl ? String(gl.getParameter(gl.VERSION)) : "none",
        center: center,
        corner: corner,
        differs: center.join(",") !== corner.join(","),
        width: width,
        height: height,
        revision: THREE.REVISION,
        elapsedMs: Math.round(performance.now() - startedAt)
      }
    });
  };
  loop();
};

self.onmessage = (event) => {
  const data = event.data;
  if (!data || data.type !== "canvas" || started) return;
  started = true;
  try {
    run(data.canvas);
  } catch (error) {
    post({ type: "scene-error", detail: describe(error) });
  }
};

post({ type: "scene-loaded", revision: THREE.REVISION });
`;

  // src/frame/jobs/render.ts
  var PROBE_TIMEOUT_MS2 = 12000;
  var LOAD_TIMEOUT_MS2 = 12000;
  var RENDER_TIMEOUT_MS = 13000;
  var CANVAS_WIDTH = 320;
  var CANVAS_HEIGHT = 200;
  var keptWorkers = [];
  var createVisibleCanvas = () => {
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    canvas.style.width = `${CANVAS_WIDTH}px`;
    canvas.style.height = `${CANVAS_HEIGHT}px`;
    canvas.style.display = "block";
    canvas.style.margin = "8px auto";
    document.body.append(canvas);
    return canvas;
  };
  var transferCanvas = (canvas) => {
    if (typeof canvas.transferControlToOffscreen !== "function") {
      throw new Error("枠の中に transferControlToOffscreen が無い");
    }
    return canvas.transferControlToOffscreen();
  };
  var valueOf = (outcome, key) => outcome.data[key];
  var renderProbeJob = async (kind) => {
    const { worker, url } = createWorker(renderProbeSource(kind));
    try {
      const outcome = await waitForMessage(worker, ["render-result", "render-error"], PROBE_TIMEOUT_MS2);
      if (outcome.kind === "message" && outcome.type === "render-result") {
        return asRecord(valueOf(outcome, "value")) ?? {};
      }
      if (outcome.kind === "message") {
        throw new Error(textField(outcome.data, "detail") || "描画に失敗");
      }
      throw new Error(outcomeDetail(outcome));
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  };
  var renderTransferJob = async () => {
    const canvas = createVisibleCanvas();
    const offscreen = transferCanvas(canvas);
    const { worker, url } = createWorker(TRANSFER_2D_SOURCE);
    try {
      worker.postMessage({ type: "canvas", canvas: offscreen }, [offscreen]);
      const outcome = await waitForMessage(worker, ["draw-result", "draw-error"], RENDER_TIMEOUT_MS);
      if (outcome.kind === "message" && outcome.type === "draw-result") {
        keptWorkers.push(worker);
        return asRecord(valueOf(outcome, "value")) ?? {};
      }
      if (outcome.kind === "message") {
        throw new Error(textField(outcome.data, "detail") || "2D の描画に失敗");
      }
      throw new Error(outcomeDetail(outcome));
    } catch (error) {
      worker.terminate();
      URL.revokeObjectURL(url);
      throw error;
    }
  };
  var renderThreeJob = async (params) => {
    const record = asRecord(params);
    const threeSource = record === undefined ? undefined : parseSource(record.threeSource);
    if (threeSource === undefined)
      throw new Error("threeSource が無い");
    const modules = [
      { name: "three", source: threeSource },
      { name: "scene", source: THREE_SCENE_SOURCE }
    ];
    const order = orderModules(modules);
    if (order.kind === "cycle")
      throw new Error("three のモジュールが循環している");
    const table = buildUrlTable(modules, order.order);
    const { worker, url: loaderUrl } = createWorker(MODULE_LOADER_SOURCE);
    try {
      worker.postMessage({ type: "boot", urls: table.urls, entry: "scene", lock: true });
      const loaded = await waitForMessage(worker, ["scene-loaded", "entry-error"], LOAD_TIMEOUT_MS2);
      if (loaded.kind !== "message")
        throw new Error(outcomeDetail(loaded));
      if (loaded.type === "entry-error") {
        throw new Error(textField(loaded.data, "detail") || "three の読み込みに失敗");
      }
      const canvas = createVisibleCanvas();
      const offscreen = transferCanvas(canvas);
      worker.postMessage({ type: "canvas", canvas: offscreen }, [offscreen]);
      const outcome = await waitForMessage(worker, ["scene-result", "scene-error"], RENDER_TIMEOUT_MS);
      if (outcome.kind === "message" && outcome.type === "scene-result") {
        keptWorkers.push(worker);
        return asRecord(valueOf(outcome, "value")) ?? {};
      }
      if (outcome.kind === "message") {
        throw new Error(textField(outcome.data, "detail") || "Three.js の描画に失敗");
      }
      throw new Error(outcomeDetail(outcome));
    } catch (error) {
      worker.terminate();
      revokeAll(table.created);
      URL.revokeObjectURL(loaderUrl);
      throw error;
    }
  };

  // src/frame/bridge.ts
  var frameEnv = () => ({
    origin: window.origin,
    worker: typeof Worker,
    transfer: typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function"
  });
  var handle = async (method, params) => {
    if (method === "frame-env")
      return frameEnv();
    if (method === "worker-env")
      return await workerEnvJob();
    if (method === "load")
      return await loadJob(params);
    if (method === "render-2d")
      return await renderProbeJob("2d");
    if (method === "render-webgl2")
      return await renderProbeJob("webgl2");
    if (method === "render-transfer")
      return await renderTransferJob();
    if (method === "render-three")
      return await renderThreeJob(params);
    throw new Error(`知らない操作: ${method}`);
  };
  var onPort = (event) => {
    if (event.source !== window.parent)
      return;
    const data = asRecord(event.data);
    if (data === undefined || data.type !== "port")
      return;
    const port = event.ports[0];
    if (port === undefined)
      return;
    window.removeEventListener("message", onPort);
    createRpc(port, handle);
  };
  window.addEventListener("message", onPort);
  window.parent.postMessage({ type: "ready" }, "*");
})();
