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

  // src/frame/workers/net.ts
  var netProbeSource = (id, target, moduleUrl, viewerUrl) => `${LOCK_CODE}
const probeId = ${JSON.stringify(id)};
const target = ${JSON.stringify(target)};
const moduleUrl = ${JSON.stringify(moduleUrl)};
const viewerUrl = ${JSON.stringify(viewerUrl)};
const post = (value) => self.postMessage({ type: "net-result", value: value });
const blocked = (error) => ({ reached: false, detail: "拒否: " + describe(error) });

const fetchProbe = async (init) => {
  if (typeof fetch !== "function") return { reached: false, detail: "fetch が無い" };
  try {
    const response = await fetch(target, init);
    return { reached: true, detail: "届いた status=" + response.status + " type=" + response.type };
  } catch (error) {
    return blocked(error);
  }
};

const xhrProbe = () =>
  new Promise((resolve) => {
    if (typeof XMLHttpRequest === "undefined") {
      resolve({ reached: false, detail: "XMLHttpRequest が無い" });
      return;
    }
    try {
      const request = new XMLHttpRequest();
      request.open("GET", target);
      request.onload = () => resolve({ reached: true, detail: "届いた status=" + request.status });
      request.onerror = () => resolve({ reached: false, detail: "error イベント" });
      request.onabort = () => resolve({ reached: false, detail: "abort イベント" });
      request.send();
    } catch (error) {
      resolve(blocked(error));
    }
  });

const importProbe = async (url) => {
  try {
    const namespace = await import(url);
    const names = namespace ? Object.getOwnPropertyNames(namespace) : [];
    return { reached: true, detail: "読めた exports=" + names.join(",") };
  } catch (error) {
    return blocked(error);
  }
};

const importScriptsProbe = () => {
  if (typeof self.importScripts !== "function") {
    return { reached: false, detail: "importScripts が無い" };
  }
  try {
    self.importScripts(target);
    return { reached: true, detail: "実行できた" };
  } catch (error) {
    return blocked(error);
  }
};

const workerProbe = () => {
  const created = [];
  for (const name of ["Worker", "SharedWorker"]) {
    const Constructor = self[name];
    if (typeof Constructor !== "function") continue;
    try {
      const made = new Constructor(moduleUrl);
      created.push(name);
      if (made && typeof made.terminate === "function") made.terminate();
      if (made && made.port && typeof made.port.close === "function") made.port.close();
    } catch (error) {
      created.push(name + "=例外");
    }
  }
  return {
    reached: created.length > 0,
    detail:
      "Worker=" + typeof self.Worker +
      " SharedWorker=" + typeof self.SharedWorker +
      " 作れた=" + (created.join(",") || "なし")
  };
};

const websocketProbe = () =>
  new Promise((resolve) => {
    if (typeof WebSocket === "undefined") {
      resolve({ reached: false, opened: false, detail: "WebSocket が無い" });
      return;
    }
    try {
      const socket = new WebSocket("wss://" + new URL(target).host + "/");
      socket.onopen = () => {
        resolve({ reached: true, opened: true, detail: "open した" });
        socket.close();
      };
      socket.onerror = () => resolve({ reached: false, opened: false, detail: "error イベント" });
      socket.onclose = () => resolve({ reached: false, opened: false, detail: "close イベント" });
    } catch (error) {
      resolve({ reached: false, opened: false, detail: "拒否: " + describe(error) });
    }
  });

const eventsourceProbe = () =>
  new Promise((resolve) => {
    if (typeof EventSource === "undefined") {
      resolve({ reached: false, opened: false, detail: "EventSource が無い" });
      return;
    }
    try {
      const source = new EventSource(target);
      source.onopen = () => {
        resolve({ reached: true, opened: true, detail: "open した" });
        source.close();
      };
      source.onerror = () => resolve({ reached: false, opened: false, detail: "error イベント" });
    } catch (error) {
      resolve({ reached: false, opened: false, detail: "拒否: " + describe(error) });
    }
  });

const beaconProbe = () => {
  const navigatorLike = self.navigator;
  if (!navigatorLike || typeof navigatorLike.sendBeacon !== "function") {
    return { reached: false, present: false, detail: "sendBeacon が無い" };
  }
  try {
    const returned = navigatorLike.sendBeacon(target, "probe");
    return {
      reached: returned === true,
      present: true,
      returned: returned === true,
      detail: "sendBeacon の戻り=" + String(returned)
    };
  } catch (error) {
    return { reached: false, present: true, detail: "sendBeacon で例外: " + describe(error) };
  }
};

const run = async () => {
  if (probeId === "s2-fetch-cors") return fetchProbe({ mode: "cors" });
  if (probeId === "s2-fetch-nocors") return fetchProbe({ mode: "no-cors" });
  if (probeId === "s2-xhr") return xhrProbe();
  if (probeId === "s2-import-room") return importProbe(moduleUrl);
  if (probeId === "s2-import-viewer") return importProbe(viewerUrl);
  if (probeId === "s2-importscripts") return importScriptsProbe();
  if (probeId === "s2-worker") return workerProbe();
  if (probeId === "s2-websocket") return websocketProbe();
  if (probeId === "s2-eventsource") return eventsourceProbe();
  if (probeId === "s2-beacon") return beaconProbe();
  return { reached: false, detail: "知らない probe: " + probeId };
};

(async () => {
  try {
    const hidden = hideEntryPoints();
    const value = Object.assign({ id: probeId }, await run(), { hidden: hidden.length });
    post(value);
  } catch (error) {
    post({ id: probeId, reached: false, failed: true, detail: describe(error) });
  }
})();
`;

  // src/frame/jobs/net.ts
  var NET_TIMEOUT_MS = 5000;
  var requiredText = (record, key) => {
    const value = record[key];
    if (typeof value !== "string" || value === "")
      throw new Error(`${key} が文字列でない`);
    return value;
  };
  var netProbeJob = async (params) => {
    const record = asRecord(params);
    if (record === undefined)
      throw new Error("params がオブジェクトでない");
    const id = requiredText(record, "id");
    const target = requiredText(record, "target");
    const moduleUrl = requiredText(record, "moduleUrl");
    const viewerUrl = requiredText(record, "viewerUrl");
    const { worker, url } = createWorker(netProbeSource(id, target, moduleUrl, viewerUrl));
    try {
      const outcome = await waitForMessage(worker, ["net-result"], NET_TIMEOUT_MS);
      if (outcome.kind === "message") {
        return asRecord(outcome.data.value) ?? { reached: false, detail: "probe の値が無い" };
      }
      if (outcome.kind === "error") {
        return { status: "worker-error", reached: false, detail: outcomeDetail(outcome) };
      }
      return { status: "timeout", reached: false, detail: "5秒で決着しなかった" };
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  };

  // src/frame/workers/preview.ts
  var PREVIEW_WORKER_SOURCE = `${LOCK_CODE}
const DRAW_MS = 5000;
const post = (message) => self.postMessage(message);
const cut = (text, limit) => (text.length > limit ? text.slice(0, limit) + "…" : text);

/** describe() の戻り値を、循環や関数を避けながら文字にする。 */
const textOf = (value) => {
  const seen = new WeakSet();
  try {
    const text = JSON.stringify(
      value,
      (key, item) => {
        if (typeof item === "function") return "[関数]";
        if (typeof item === "bigint") return String(item) + "n";
        if (typeof item === "object" && item !== null) {
          if (seen.has(item)) return "[循環]";
          seen.add(item);
        }
        return item;
      },
      2
    );
    return text === undefined ? String(value) : text;
  } catch (error) {
    return describe(error);
  }
};

const runDraw = (drawFn, canvas) => {
  if (!canvas || typeof canvas.getContext !== "function") {
    post({ type: "preview-unsupported", detail: "この環境では描けません（Worker にキャンバスを渡せません）" });
    return;
  }
  const context = canvas.getContext("2d");
  if (!context) {
    post({ type: "preview-unsupported", detail: "この環境では描けません（Worker の中に 2D コンテキストが無い）" });
    return;
  }
  const width = canvas.width;
  const height = canvas.height;
  const startedAt = performance.now();
  let frames = 0;
  const loop = () => {
    const seconds = (performance.now() - startedAt) / 1000;
    try {
      drawFn(context, seconds, width, height);
    } catch (error) {
      post({ type: "preview-error", phase: "draw", detail: cut(describe(error), 300) });
      return;
    }
    frames += 1;
    post({ type: "preview-tick", frames: frames });
    if (performance.now() - startedAt < DRAW_MS) {
      setTimeout(loop, 16);
    } else {
      post({ type: "preview-frames", frames: frames });
    }
  };
  loop();
};

const run = async (data) => {
  const urls = data.urls && typeof data.urls === "object" ? data.urls : {};
  const entryUrl = urls[data.entry];
  if (typeof entryUrl !== "string") {
    post({ type: "preview-error", phase: "load", detail: "提出されたモジュールの URL がありません" });
    return;
  }
  try {
    hideEntryPoints();
  } catch (error) {
    // 前置きの片付けに失敗しても、読み込みは続ける。外への入口は CSP が塞いでいる。
  }

  let namespace;
  try {
    namespace = await import(entryUrl);
  } catch (error) {
    post({ type: "preview-error", phase: "load", detail: cut(describe(error), 300) });
    return;
  }
  post({ type: "preview-loaded" });

  const describeFn = namespace && typeof namespace.describe === "function" ? namespace.describe : null;
  const drawFn = namespace && typeof namespace.draw === "function" ? namespace.draw : null;
  post({ type: "preview-info", describe: describeFn !== null, draw: drawFn !== null });
  if (!describeFn && !drawFn) {
    post({ type: "preview-nothing" });
    return;
  }

  if (describeFn) {
    let text;
    try {
      text = textOf(describeFn());
    } catch (error) {
      post({ type: "preview-error", phase: "describe", detail: cut(describe(error), 300) });
      return;
    }
    post({ type: "preview-describe", text: cut(text, 2000) });
  }

  if (drawFn) {
    runDraw(drawFn, data.canvas);
    return;
  }
  post({ type: "preview-done" });
};

let started = false;
self.onmessage = (event) => {
  const data = event.data;
  if (!data || data.type !== "boot" || started) return;
  started = true;
  run(data).catch((error) => {
    post({ type: "preview-error", phase: "internal", detail: cut(describe(error), 300) });
  });
};
`;

  // src/frame/workers/chaos.ts
  var SPIN_SOURCE = `${LOCK_CODE}
try {
  hideEntryPoints();
  self.postMessage({ type: "spin-started" });
} catch (error) {
  self.postMessage({ type: "spin-error", detail: describe(error) });
}
for (;;) {}
`;
  var ECHO_SOURCE = `${LOCK_CODE}
try {
  hideEntryPoints();
  self.postMessage({ type: "echo-ready", value: 1 + 1 });
} catch (error) {
  self.postMessage({ type: "echo-error", detail: describe(error) });
}
`;
  var FLOOD_SOURCE = `${LOCK_CODE}
try {
  hideEntryPoints();
} catch (error) {
  self.postMessage({ type: "flood-error", detail: describe(error) });
}
const chunk = "x".repeat(1024);
for (let index = 0; index < 20000; index += 1) {
  self.postMessage({ type: "flood", data: chunk });
}
self.postMessage({ type: "flood-done", count: 20000 });
`;

  // src/frame/jobs/watch.ts
  var SILENCE_MS = 1000;
  var WATCH_SILENCE_MS = SILENCE_MS;
  var ECHO_TIMEOUT_MS = 3000;
  var FLOOD_WINDOW_MS = 1000;
  var FLOOD_LIMIT = 1000;
  var FLOOD_MAX_MS = 1e4;
  var waitForSilence = (worker, silenceMs, onSilent) => new Promise((resolve) => {
    let timer;
    let settled = false;
    const finish = () => {
      if (settled)
        return;
      settled = true;
      if (timer !== undefined)
        clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      onSilent();
      resolve();
    };
    const arm = () => {
      if (settled)
        return;
      if (timer !== undefined)
        clearTimeout(timer);
      timer = setTimeout(finish, silenceMs);
    };
    const onMessage = () => arm();
    const onError = () => finish();
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    arm();
  });
  var spinJob = async () => {
    const started = performance.now();
    let terminateMs = 0;
    const spin = createWorker(SPIN_SOURCE);
    try {
      await waitForSilence(spin.worker, SILENCE_MS, () => {
        terminateMs = round1(performance.now() - started);
        spin.worker.terminate();
      });
    } finally {
      spin.worker.terminate();
      URL.revokeObjectURL(spin.url);
    }
    const echoStarted = performance.now();
    const echo = createWorker(ECHO_SOURCE);
    try {
      const outcome = await waitForMessage(echo.worker, ["echo-ready"], ECHO_TIMEOUT_MS);
      const value = outcome.kind === "message" ? outcome.data.value : undefined;
      return {
        stopped: terminateMs > 0,
        terminateMs,
        silenceMs: SILENCE_MS,
        echoOk: value === 2,
        echoValue: typeof value === "number" ? value : null,
        echoMs: round1(performance.now() - echoStarted)
      };
    } finally {
      echo.worker.terminate();
      URL.revokeObjectURL(echo.url);
    }
  };
  var floodJob = async () => {
    const { worker, url } = createWorker(FLOOD_SOURCE);
    const started = performance.now();
    const times = [];
    let received = 0;
    let reason = "time";
    let stoppedMs = 0;
    try {
      await new Promise((resolve) => {
        let settled = false;
        const finish = (next) => {
          if (settled)
            return;
          settled = true;
          reason = next;
          stoppedMs = round1(performance.now() - started);
          clearTimeout(timer);
          worker.terminate();
          resolve();
        };
        const timer = setTimeout(() => finish("time"), FLOOD_MAX_MS);
        worker.addEventListener("message", (event) => {
          const data = asRecord(event.data);
          if (data === undefined)
            return;
          if (data.type === "flood") {
            received += 1;
            const now = performance.now();
            times.push(now);
            while (times.length > 0) {
              const oldest = times[0];
              if (oldest === undefined || now - oldest < FLOOD_WINDOW_MS)
                break;
              times.shift();
            }
            if (times.length > FLOOD_LIMIT)
              finish("limit");
            return;
          }
          if (data.type === "flood-done")
            finish("done");
        });
        worker.addEventListener("error", () => finish("error"));
      });
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
    return {
      stopped: reason === "limit",
      reason,
      received,
      limitMs: stoppedMs,
      windowMs: FLOOD_WINDOW_MS,
      limit: FLOOD_LIMIT
    };
  };

  // src/frame/jobs/preview.ts
  var SILENCE_MS2 = WATCH_SILENCE_MS;
  var HARD_LIMIT_MS = 20000;
  var CANVAS_WIDTH = 320;
  var CANVAS_HEIGHT = 200;
  var active;
  var previousCanvas;
  var recordOf = (value, limit) => typeof value === "string" ? value.slice(0, limit) : undefined;
  var previewStopJob = () => {
    const current = active;
    if (current === undefined)
      return { stopped: false };
    current.stop();
    return { stopped: true };
  };
  var createCanvas = () => {
    previousCanvas?.remove();
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    canvas.style.cssText = `width:${String(CANVAS_WIDTH)}px;height:${String(CANVAS_HEIGHT)}px;` + "display:block;margin:8px auto;background:#101820";
    document.body.append(canvas);
    previousCanvas = canvas;
    return canvas;
  };
  var transfer = (canvas) => {
    if (typeof canvas.transferControlToOffscreen !== "function")
      return null;
    try {
      return canvas.transferControlToOffscreen();
    } catch {
      return null;
    }
  };
  var previewRunJob = async (params) => {
    const record = asRecord(params);
    if (record === undefined)
      throw new Error("params がオブジェクトでない");
    const modules = parseModules(record["modules"]);
    const name = parseEntry(record["name"]);
    if (modules === undefined || name === undefined)
      throw new Error("modules か name の形が不正");
    if (!modules.some((module) => module.name === name)) {
      throw new Error(`提出されたモジュールが無い: ${name}`);
    }
    const order = orderModules(modules);
    if (order.kind === "cycle")
      throw new Error(`循環する読み込み: ${order.cycle.join(" → ")}`);
    const table = buildUrlTable(modules, order.order);
    const canvas = createCanvas();
    const offscreen = transfer(canvas);
    const { worker, url: workerUrl } = createWorker(PREVIEW_WORKER_SOURCE);
    const started = performance.now();
    const collected = {
      status: "ok",
      describePresent: false,
      nothing: false,
      drawPresent: false,
      frames: 0,
      stopped: false
    };
    try {
      await new Promise((resolve) => {
        let settled = false;
        let silence;
        let limit;
        const finish = () => {
          if (settled)
            return;
          settled = true;
          if (silence !== undefined)
            clearTimeout(silence);
          if (limit !== undefined)
            clearTimeout(limit);
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          resolve();
        };
        const stopNow = () => {
          collected.status = "stopped";
          collected.stopped = true;
          worker.terminate();
          finish();
        };
        const arm = () => {
          if (settled)
            return;
          if (silence !== undefined)
            clearTimeout(silence);
          silence = setTimeout(stopNow, SILENCE_MS2);
        };
        const onMessage = (event) => {
          const data = asRecord(event.data);
          if (data === undefined || typeof data.type !== "string")
            return;
          if (data.type === "preview-loaded") {
            arm();
            return;
          }
          if (data.type === "preview-info") {
            collected.describePresent = data["describe"] === true;
            collected.drawPresent = data["draw"] === true;
            arm();
            return;
          }
          if (data.type === "preview-nothing") {
            collected.nothing = true;
            finish();
            return;
          }
          if (data.type === "preview-done") {
            finish();
            return;
          }
          if (data.type === "preview-describe") {
            collected.describePresent = true;
            const text = recordOf(data["text"], 2000);
            if (text === undefined)
              collected.describeError = "describe() の戻り値を文字にできません";
            else
              collected.describeText = text;
            arm();
            return;
          }
          if (data.type === "preview-tick") {
            const frames = data["frames"];
            if (typeof frames === "number")
              collected.frames = frames;
            arm();
            return;
          }
          if (data.type === "preview-frames") {
            const frames = data["frames"];
            if (typeof frames === "number")
              collected.frames = frames;
            collected.drawPresent = true;
            finish();
            return;
          }
          if (data.type === "preview-unsupported") {
            collected.drawPresent = true;
            collected.drawUnsupported = recordOf(data["detail"], 300) ?? "この環境では描けません";
            finish();
            return;
          }
          if (data.type === "preview-error") {
            const detail = recordOf(data["detail"], 300) ?? "失敗しました";
            const phase = data["phase"];
            collected.status = "error";
            if (phase === "load")
              collected.loadError = detail;
            else if (phase === "describe")
              collected.describeError = detail;
            else {
              collected.drawPresent = true;
              collected.drawError = detail;
            }
            finish();
          }
        };
        const onError = (event) => {
          const detail = event.message === "" ? "Worker が止まった" : event.message;
          collected.status = "error";
          collected.loadError = detail.slice(0, 300);
          finish();
        };
        active = { stop: stopNow };
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
        arm();
        limit = setTimeout(stopNow, HARD_LIMIT_MS);
        worker.postMessage({ type: "boot", urls: table.urls, entry: name, canvas: offscreen }, offscreen === null ? [] : [offscreen]);
      });
    } catch (error) {
      collected.status = "error";
      collected.loadError = describeError(error).slice(0, 300);
    } finally {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      revokeAll(table.created);
      active = undefined;
    }
    return {
      status: collected.status,
      describePresent: collected.describePresent,
      describeText: collected.describeText ?? null,
      describeError: collected.describeError ?? null,
      nothing: collected.nothing,
      drawPresent: collected.drawPresent,
      frames: collected.frames,
      drawError: collected.drawError ?? null,
      drawUnsupported: collected.drawUnsupported ?? null,
      loadError: collected.loadError ?? null,
      stopped: collected.stopped,
      elapsedMs: round1(performance.now() - started)
    };
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

  // src/frame/workers/recover.ts
  var ATTEMPTS = `
(async () => {
const results = [];
const attempt = async (group, label, fn) => {
  let status = "info";
  let detail = "";
  try {
    const outcome = await fn();
    status = outcome.status;
    detail = outcome.detail;
  } catch (error) {
    status = "blocked";
    detail = describe(error);
  }
  results.push({
    group: group,
    label: label,
    status: status,
    detail: String(detail).slice(0, 300)
  });
};
const kind = (value) => typeof value;
const text = (value) => String(value).slice(0, 80);
const raceMs = (promise, ms) =>
  Promise.race([
    promise.then(
      (value) => ({ ok: true, value: value }),
      (error) => ({ ok: false, error: error })
    ),
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: false, error: { name: "Timeout", message: ms + "ms" } }), ms)
    )
  ]);

const hidden = hideEntryPoints();

await attempt("worker", "self.Worker", () => ({
  status: self.Worker === undefined ? "absent" : "recovered",
  detail: kind(self.Worker) + " " + text(self.Worker)
}));
await attempt("worker", "globalThis.Worker", () => ({
  status: globalThis.Worker === undefined ? "absent" : "recovered",
  detail: kind(globalThis.Worker)
}));
await attempt("worker", "Object.getPrototypeOf(self).Worker", () => {
  const proto = Object.getPrototypeOf(self);
  return {
    status: proto.Worker === undefined ? "absent" : "recovered",
    detail: kind(proto.Worker)
  };
});
await attempt("worker", "self.constructor.prototype.Worker", () => {
  const proto = self.constructor && self.constructor.prototype;
  if (!proto) return { status: "absent", detail: "constructor 無し" };
  return {
    status: proto.Worker === undefined ? "absent" : "recovered",
    detail: kind(proto.Worker)
  };
});
await attempt("worker", "self.SharedWorker", () => ({
  status: self.SharedWorker === undefined ? "absent" : "recovered",
  detail: kind(self.SharedWorker)
}));
await attempt("worker", "new DedicatedWorkerGlobalScope()", () => {
  if (typeof DedicatedWorkerGlobalScope === "undefined") {
    return { status: "absent", detail: "DedicatedWorkerGlobalScope が無い" };
  }
  try {
    const made = new DedicatedWorkerGlobalScope();
    return { status: "recovered", detail: "作れてしまった: " + kind(made) };
  } catch (error) {
    return { status: "blocked", detail: describe(error) };
  }
});
await attempt("worker", "Reflect.construct(self.constructor, [])", () => {
  const made = Reflect.construct(self.constructor, []);
  return { status: "recovered", detail: "作れてしまった: " + kind(made) };
});
await attempt("worker", "プロトタイプをたどって Worker を探す", () => {
  const names = [];
  let cursor = self;
  let depth = 0;
  while (cursor !== null && depth < 8) {
    for (const name of Object.getOwnPropertyNames(cursor)) names.push(name);
    cursor = Object.getPrototypeOf(cursor);
    depth += 1;
  }
  const hits = names.filter((name) => name.toLowerCase().indexOf("worker") >= 0);
  return { status: "info", detail: "見つかった名前=" + JSON.stringify(hits) };
});

await attempt("code", "URL.createObjectURL", () => ({
  status: URL.createObjectURL === undefined ? "absent" : "recovered",
  detail: kind(URL.createObjectURL)
}));
await attempt("code", "self.URL.createObjectURL", () => ({
  status: self.URL.createObjectURL === undefined ? "absent" : "recovered",
  detail: kind(self.URL.createObjectURL)
}));
await attempt("code", "self.webkitURL.createObjectURL", () => {
  const webkit = self.webkitURL;
  if (!webkit) return { status: "absent", detail: "webkitURL 無し" };
  return {
    status: webkit.createObjectURL === undefined ? "absent" : "recovered",
    detail: kind(webkit.createObjectURL)
  };
});
await attempt("code", "new URL(...).constructor.createObjectURL", () => {
  const made = new URL("https://x.invalid/");
  return {
    status: made.constructor.createObjectURL === undefined ? "absent" : "recovered",
    detail: kind(made.constructor.createObjectURL)
  };
});
await attempt("code", "Object.getOwnPropertyNames(URL)", () => ({
  status: "info",
  detail: JSON.stringify(Object.getOwnPropertyNames(URL))
}));
await attempt("code", "importScripts の型", () => ({
  status: self.importScripts === undefined ? "absent" : "recovered",
  detail: kind(self.importScripts)
}));
await attempt("code", "importScripts(data:)", () => {
  if (typeof self.importScripts !== "function") {
    return { status: "absent", detail: "importScripts が無い" };
  }
  self.importScripts("data:text/javascript,self.__importScriptsRan=1");
  return { status: "recovered", detail: "ran=" + String(self.__importScriptsRan) };
});
await attempt("code", 'eval("1")', () => ({
  status: "recovered",
  detail: "value=" + String(eval("1"))
}));
await attempt("code", 'new Function("return 1")()', () => ({
  status: "recovered",
  detail: "value=" + String(new Function("return 1")())
}));
await attempt("code", 'import("data:text/javascript,export default 1")', async () => {
  const module = await import("data:text/javascript,export default 1");
  return { status: "recovered", detail: "default=" + String(module.default) };
});
await attempt("code", "import(Blob をそのまま)", async () => {
  const blob = new Blob(["export default 7;"], { type: "text/javascript" });
  const module = await import(blob);
  return { status: "recovered", detail: "default=" + String(module.default) };
});
await attempt("code", "FileReaderSync の型", () => ({
  status: typeof FileReaderSync === "undefined" ? "absent" : "info",
  detail: kind(FileReaderSync)
}));
await attempt("code", "FileReaderSync -> data URL -> import", async () => {
  if (typeof FileReaderSync === "undefined") return { status: "absent", detail: "FileReaderSync 無し" };
  const reader = new FileReaderSync();
  const dataUrl = reader.readAsDataURL(new Blob(["export default 3;"], { type: "text/javascript" }));
  const module = await import(dataUrl);
  return { status: "recovered", detail: "default=" + String(module.default) };
});
await attempt("worker", "navigator.serviceWorker.register", async () => {
  const container = navigator.serviceWorker;
  if (!container) return { status: "absent", detail: "serviceWorker 無し" };
  const registered = await raceMs(container.register(String(self.location.href)), 1500);
  return {
    status: registered.ok ? "recovered" : "blocked",
    detail: registered.ok ? "登録できた" : describe(registered.error)
  };
});

self.postMessage({
  type: "recover-result",
  value: { hidden: hidden.length, attempts: results }
});
})().catch((error) => {
  self.postMessage({ type: "recover-error", detail: describe(error) });
});
`;
  var RECOVER_SOURCE = `${LOCK_CODE}${ATTEMPTS}`;

  // src/frame/jobs/recover.ts
  var RECOVER_TIMEOUT_MS = 20000;
  var recoverJob = async () => {
    const { worker, url } = createWorker(RECOVER_SOURCE);
    try {
      const outcome = await waitForMessage(worker, ["recover-result", "recover-error"], RECOVER_TIMEOUT_MS);
      if (outcome.kind === "message" && outcome.type === "recover-result") {
        return asRecord(outcome.data.value) ?? { attempts: [] };
      }
      if (outcome.kind === "message") {
        throw new Error(textField(outcome.data, "detail") || "取り戻しの試験が失敗した");
      }
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
  var CANVAS_WIDTH2 = 320;
  var CANVAS_HEIGHT2 = 200;
  var keptWorkers = [];
  var createVisibleCanvas = () => {
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH2;
    canvas.height = CANVAS_HEIGHT2;
    canvas.style.width = `${CANVAS_WIDTH2}px`;
    canvas.style.height = `${CANVAS_HEIGHT2}px`;
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
    if (method === "net-probe")
      return await netProbeJob(params);
    if (method === "recover")
      return await recoverJob();
    if (method === "spin")
      return await spinJob();
    if (method === "flood")
      return await floodJob();
    if (method === "render-2d")
      return await renderProbeJob("2d");
    if (method === "render-webgl2")
      return await renderProbeJob("webgl2");
    if (method === "render-transfer")
      return await renderTransferJob();
    if (method === "render-three")
      return await renderThreeJob(params);
    if (method === "preview-run")
      return await previewRunJob(params);
    if (method === "preview-stop")
      return previewStopJob();
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
  var isIsolated = () => self.origin === "null" && window.parent !== window;
  var refuse = () => {
    document.body.textContent = "隔離されていないので動きません";
    if (window.parent !== window)
      window.parent.postMessage({ type: "refused" }, "*");
  };
  if (isIsolated()) {
    Reflect.set(window, "__bridgeStarted", true);
    window.addEventListener("message", onPort);
    window.parent.postMessage({ type: "ready" }, "*");
  } else {
    refuse();
  }
})();
