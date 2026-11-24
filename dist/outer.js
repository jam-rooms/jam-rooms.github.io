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

  // src/shared/room-args.ts
  var isAllowedBase = (url) => {
    if (url.username !== "" || url.password !== "")
      return false;
    if (url.search !== "" || url.hash !== "")
      return false;
    if (url.protocol === "https:")
      return true;
    return url.protocol === "http:" && url.hostname === "127.0.0.1";
  };
  var parseOne = (raw) => {
    const separator = raw.indexOf("|");
    if (separator <= 0) {
      return { problem: `「${raw}」の形が違う（<ラベル>|<基底URL> にする）` };
    }
    const label = raw.slice(0, separator).trim();
    const base = raw.slice(separator + 1).trim();
    if (label === "")
      return { problem: "ラベルが空" };
    if (base === "")
      return { problem: `${label}: 基底URLが空` };
    let url;
    try {
      url = new URL(base);
    } catch {
      return { problem: `${label}: 基底URLとして読めない（${base}）` };
    }
    if (!isAllowedBase(url)) {
      return {
        problem: `${label}: 基底URLは https: か http://127.0.0.1 だけ（${base}）`
      };
    }
    if (!url.pathname.endsWith("/"))
      url.pathname = `${url.pathname}/`;
    return { room: { label, baseUrl: url.href } };
  };
  var parseRoomArgs = (values) => {
    const rooms = [];
    const problems = [];
    for (const value of values) {
      const parsed = parseOne(value);
      if (parsed.room !== undefined)
        rooms.push(parsed.room);
      if (parsed.problem !== undefined)
        problems.push(parsed.problem);
    }
    return { rooms, problems };
  };
  var USAGE_LINES = [
    "使い方: ?room=<ラベル>|<基底URL> を1つ以上付けて開いてください。",
    "例: ?room=local|http://127.0.0.1:4331/",
    "基底URLは https: か http://127.0.0.1 だけを受け付けます。"
  ];

  // src/shared/urls.ts
  var isAllowedPageUrl = (href) => {
    let url;
    try {
      url = new URL(href);
    } catch {
      return false;
    }
    if (url.username !== "" || url.password !== "")
      return false;
    if (url.protocol === "https:")
      return true;
    return url.protocol === "http:" && url.hostname === "127.0.0.1";
  };
  var probeTarget = (manifestUrl, id) => {
    const url = new URL(manifestUrl);
    url.searchParams.set("probe", id);
    return url.href;
  };
  var viewerScriptUrl = (pageHref) => new URL("dist/outer.js", pageHref).href;
  var embedLink = (roomBaseUrl, viewerHref) => {
    if (!isAllowedPageUrl(viewerHref))
      return;
    let embed;
    try {
      embed = new URL("embed.html", roomBaseUrl);
    } catch {
      return;
    }
    if (!isAllowedPageUrl(embed.href))
      return;
    const href = new URL(embed.href);
    href.searchParams.set("viewer", viewerHref);
    return isAllowedPageUrl(href.href) ? href.href : undefined;
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

  // src/outer/frame-client.ts
  var waitForReady = (iframe, timeoutMs) => new Promise((resolve, reject) => {
    const onMessage = (event) => {
      if (event.source !== iframe.contentWindow)
        return;
      const data = asRecord(event.data);
      if (data === undefined || data.type !== "ready")
        return;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("枠から ready が来ない（frame.html を読めているか）"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
    window.addEventListener("message", onMessage);
  });
  var connectFrame = async (timeoutMs = 1e4) => {
    const host = document.getElementById("frame-host");
    if (host === null)
      throw new Error("画面に frame-host が無い");
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("title", "隔離した枠");
    iframe.src = "frame.html";
    const ready = waitForReady(iframe, timeoutMs);
    host.append(iframe);
    await ready;
    const target = iframe.contentWindow;
    if (target === null)
      throw new Error("枠の window が無い");
    const channel = new MessageChannel;
    target.postMessage({ type: "port" }, "*", [channel.port2]);
    const rpc = createRpc(channel.port1);
    return {
      call: (method, params, callTimeoutMs) => rpc.call(method, params, callTimeoutMs),
      close: () => {
        rpc.close();
        iframe.remove();
      }
    };
  };
  var missingFrame = (reason) => ({
    call: async () => {
      throw new Error(`枠が無い: ${reason}`);
    },
    close: () => {
      return;
    }
  });

  // src/outer/runner.ts
  var attempt = async (timeoutMs, body) => {
    const started = performance.now();
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve({ verdict: "error", detail: `時間切れ（${timeoutMs}ms）` });
      }, timeoutMs);
    });
    try {
      const outcome = await Promise.race([body(), timeout]);
      return { ...outcome, ms: round1(performance.now() - started) };
    } catch (error) {
      return {
        verdict: "FAIL",
        detail: `例外: ${describeError(error)}`,
        ms: round1(performance.now() - started)
      };
    } finally {
      if (timer !== undefined)
        clearTimeout(timer);
    }
  };
  var createRunner = (ui) => {
    const lines = [];
    const rows = [];
    const run = async (meta, timeoutMs, body) => {
      const result = await attempt(timeoutMs, body);
      const row = {
        section: meta.section,
        id: meta.id,
        ...meta.source === undefined ? {} : { source: meta.source },
        expect: meta.expect,
        verdict: result.verdict,
        detail: result.detail,
        ms: result.ms
      };
      rows.push(row);
      ui.addRow(row);
      return { verdict: result.verdict, detail: result.detail };
    };
    return {
      run,
      note: (line) => {
        lines.push(line);
      },
      notes: () => [...lines],
      rows: () => [...rows]
    };
  };

  // src/outer/s0.ts
  var record = (detail) => ({ verdict: "info", detail });
  var outerEnv = () => {
    const transfer = "transferControlToOffscreen" in HTMLCanvasElement.prototype;
    return record(`origin=${location.origin} crossOriginIsolated=${String(window.crossOriginIsolated)} ` + `OffscreenCanvas=${typeof OffscreenCanvas} transferControlToOffscreen=${transfer}`);
  };
  var frameEnv = async (frame) => {
    try {
      const value = asRecord(await frame.call("frame-env", {}, 12000));
      if (value === undefined)
        return record("枠から値が来なかった");
      return record(`origin=${String(value.origin)} Worker=${String(value.worker)} transfer=${String(value.transfer)}`);
    } catch (error) {
      return record(`取得できず: ${describeError(error)}`);
    }
  };
  var workerEnv = async (frame) => {
    try {
      const value = asRecord(await frame.call("worker-env", {}, 12000));
      if (value === undefined)
        return record("Worker から値が来なかった");
      return record(`OffscreenCanvas=${String(value.offscreenCanvas)} ` + `requestAnimationFrame=${String(value.requestAnimationFrame)} ` + `WebGL2RenderingContext=${String(value.webgl2)} ` + `AudioContext=${String(value.audioContext)} ` + `RTCPeerConnection=${String(value.rtc)} ` + `origin=${String(value.origin)}`);
    } catch (error) {
      return record(`取得できず: ${describeError(error)}`);
    }
  };
  var runS0 = async (runner, frame) => {
    await runner.run({ section: "S0", id: "s0-outer", expect: "record" }, 15000, async () => outerEnv());
    await runner.run({ section: "S0", id: "s0-frame", expect: "record" }, 15000, async () => frameEnv(frame));
    await runner.run({ section: "S0", id: "s0-worker", expect: "record" }, 15000, async () => workerEnv(frame));
  };

  // src/shared/concurrency.ts
  var mapWithConcurrency = async (items, limit, run) => {
    const results = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length)
          return;
        const item = items[index];
        if (item === undefined)
          return;
        results[index] = await run(item, index);
      }
    };
    const width = Math.max(1, Math.min(limit, items.length));
    const workers = [];
    for (let index = 0;index < width; index += 1)
      workers.push(worker());
    await Promise.all(workers);
    return results;
  };

  // src/shared/http.ts
  var fetchResource = async (url) => {
    const started = performance.now();
    const response = await fetch(url, { cache: "no-store" });
    const buffer = await response.arrayBuffer();
    return {
      url,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type") ?? "(なし)",
      bytes: buffer.byteLength,
      buffer,
      ms: round1(performance.now() - started)
    };
  };
  var decodeText = (buffer) => new TextDecoder().decode(buffer);
  var sha256Hex = async (buffer) => {
    if (crypto.subtle === undefined)
      throw new Error("crypto.subtle が無い");
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  var urlInRoom = (baseUrl, path) => new URL(path, baseUrl).href;

  // src/shared/manifest.ts
  var HEX_PATTERN = /^[0-9a-fA-F]{64}$/;
  var isSafeRelativePath = (path) => {
    if (path === "" || path.startsWith("/") || path.startsWith("\\"))
      return false;
    if (path.includes("..") || path.includes("\\") || path.includes("\x00"))
      return false;
    try {
      const url = new URL(path, "https://room.invalid/base/");
      return url.origin === "https://room.invalid" && url.pathname.startsWith("/base/");
    } catch {
      return false;
    }
  };
  var parseEntry = (value) => {
    const record2 = asRecord(value);
    if (record2 === undefined)
      return;
    const { name, path, sha256, bytes } = record2;
    if (typeof name !== "string" || name === "")
      return;
    if (typeof path !== "string" || !isSafeRelativePath(path))
      return;
    if (typeof sha256 !== "string" || !HEX_PATTERN.test(sha256))
      return;
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0)
      return;
    return { name, path, sha256: sha256.toLowerCase(), bytes };
  };
  var parseList = (value) => {
    if (!Array.isArray(value))
      return;
    const entries = [];
    for (const item of value) {
      const entry = parseEntry(item);
      if (entry === undefined)
        return;
      entries.push(entry);
    }
    return entries;
  };
  var parseManifest = (value) => {
    const record2 = asRecord(value);
    if (record2 === undefined)
      return;
    if (record2.format !== 1)
      return;
    if (typeof record2.entry !== "string" || record2.entry === "")
      return;
    const modules = parseList(record2.modules);
    const lib = parseList(record2.lib);
    if (modules === undefined || lib === undefined)
      return;
    const names = new Set;
    for (const entry of [...modules, ...lib]) {
      if (names.has(entry.name))
        return;
      names.add(entry.name);
    }
    if (!modules.some((entry) => entry.name === record2.entry))
      return;
    return { format: 1, entry: record2.entry, modules, lib };
  };

  // src/outer/bulk.ts
  var EXPECTED_COUNT = 500;
  var HEX_PATTERN2 = /^[0-9a-fA-F]{64}$/;
  var parseBulkIndex = (value) => {
    if (!Array.isArray(value))
      return;
    const entries = [];
    const paths = new Set;
    for (const item of value) {
      if (typeof item !== "object" || item === null || Array.isArray(item))
        return;
      const record2 = item;
      const { path, sha256, bytes } = record2;
      if (typeof path !== "string" || !isSafeRelativePath(path) || paths.has(path))
        return;
      if (typeof sha256 !== "string" || !HEX_PATTERN2.test(sha256))
        return;
      if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0)
        return;
      paths.add(path);
      entries.push({ path, sha256: sha256.toLowerCase(), bytes });
    }
    return entries;
  };
  var fail = (detail) => ({ verdict: "FAIL", detail });
  var probeBulk = async (room) => {
    const started = performance.now();
    let index;
    try {
      index = await fetchResource(urlInRoom(room.baseUrl, "bulk/index.json"));
    } catch (error) {
      return fail(`bulk/index.json の取得に失敗: ${describeError(error)}`);
    }
    if (!index.ok)
      return fail(`bulk/index.json が読めない status=${index.status}`);
    let parsed;
    try {
      parsed = JSON.parse(decodeText(index.buffer));
    } catch {
      return fail("bulk/index.json を JSON として読めない");
    }
    const entries = parseBulkIndex(parsed);
    if (entries === undefined)
      return fail("bulk/index.json の形が不正");
    if (entries.length !== EXPECTED_COUNT) {
      return fail(`bulk/index.json の件数が ${entries.length}（${EXPECTED_COUNT} のはず）`);
    }
    const results = await mapWithConcurrency(entries, 8, async (entry) => {
      try {
        const fetched = await fetchResource(urlInRoom(room.baseUrl, entry.path));
        const hash = await sha256Hex(fetched.buffer);
        return { entry, status: fetched.status, bytes: fetched.bytes, hash, error: "" };
      } catch (error) {
        return { entry, status: 0, bytes: 0, hash: "", error: describeError(error) };
      }
    });
    const success = results.filter((item) => item.status === 200).length;
    const matched = results.filter((item) => item.hash === item.entry.sha256).length;
    const failed = results.filter((item) => item.status !== 200 || item.hash !== item.entry.sha256);
    const statusCounts = new Map;
    let networkFailures = 0;
    for (const item of failed) {
      if (item.status === 0)
        networkFailures += 1;
      else
        statusCounts.set(item.status, (statusCounts.get(item.status) ?? 0) + 1);
    }
    const statusText = [...statusCounts.entries()].map(([status, count]) => `${status}:${count}`).join(" ") || "なし";
    const totalBytes = results.reduce((sum, item) => sum + item.bytes, 0);
    const elapsed = performance.now() - started;
    const example = failed[0];
    const exampleText = example === undefined ? "" : ` 例=${example.entry.path}${example.error === "" ? "" : ` (${example.error})`}`;
    const detail = `一致 ${matched}/${EXPECTED_COUNT} 成功 ${success} 失敗 ${failed.length}` + `（status ${statusText}${networkFailures === 0 ? "" : ` 通信失敗 ${networkFailures}`}）` + ` 合計 ${formatBytes(totalBytes)} ${formatMs(elapsed)}${exampleText}`;
    const ok = matched === EXPECTED_COUNT && success === EXPECTED_COUNT && failed.length === 0;
    return { verdict: ok ? "pass" : "FAIL", detail };
  };

  // src/outer/s1.ts
  var loadEntries = async (baseUrl, entries, limit) => await mapWithConcurrency(entries, limit, async (entry) => {
    try {
      const fetched = await fetchResource(urlInRoom(baseUrl, entry.path));
      const hash = await sha256Hex(fetched.buffer);
      return {
        entry,
        status: fetched.status,
        bytes: fetched.bytes,
        hash,
        text: decodeText(fetched.buffer)
      };
    } catch (error) {
      return { entry, status: 0, bytes: 0, hash: "", error: describeError(error) };
    }
  });
  var sourcesOf = (loaded) => {
    const sources = [];
    for (const item of loaded) {
      if (item.text !== undefined)
        sources.push({ name: item.entry.name, source: item.text });
    }
    return sources;
  };
  var summarize = (loaded, mismatched, elapsedMs) => {
    const totalBytes = loaded.reduce((sum, item) => sum + item.bytes, 0);
    const bad = mismatched.map((item) => item.entry.name).join(",");
    return `一致 ${loaded.length - mismatched.length}/${loaded.length} 合計 ${formatBytes(totalBytes)} ` + `${formatMs(elapsedMs)}${bad === "" ? "" : ` 不一致=${bad}`}`;
  };
  var meta = (room, id) => ({
    section: "S1",
    id,
    source: room.label,
    expect: "pass"
  });
  var runRoomS1 = async (room, runner) => {
    let manifest;
    let modules = [];
    let libThree;
    let modulesMatched = 0;
    let modulesTotal = 0;
    let libMatched = 0;
    let libTotal = 0;
    const manifestResult = await runner.run(meta(room, "s1-manifest"), 15000, async () => {
      try {
        const fetched = await fetchResource(urlInRoom(room.baseUrl, "manifest.json"));
        const head = `status=${fetched.status} type=${fetched.contentType} ${formatMs(fetched.ms)}`;
        if (!fetched.ok)
          return { verdict: "FAIL", detail: `manifest.json が読めない ${head}` };
        let parsed;
        try {
          parsed = JSON.parse(decodeText(fetched.buffer));
        } catch {
          return { verdict: "FAIL", detail: `manifest.json を JSON として読めない ${head}` };
        }
        const candidate = parseManifest(parsed);
        if (candidate === undefined) {
          return { verdict: "FAIL", detail: `manifest.json の形が不正 ${head}` };
        }
        manifest = candidate;
        return {
          verdict: "pass",
          detail: `${head} modules=${candidate.modules.length} lib=${candidate.lib.length}`
        };
      } catch (error) {
        return { verdict: "FAIL", detail: `manifest.json の取得に失敗: ${describeError(error)}` };
      }
    });
    const current = manifest;
    if (current === undefined) {
      await runner.run(meta(room, "s1-modules"), 15000, async () => ({
        verdict: "FAIL",
        detail: "manifest が使えないため実行していない"
      }));
      await runner.run(meta(room, "s1-lib"), 15000, async () => ({
        verdict: "FAIL",
        detail: "manifest が使えないため実行していない"
      }));
    } else {
      modulesTotal = current.modules.length;
      const modulesResult = await runner.run(meta(room, "s1-modules"), 15000, async () => {
        let started = 0;
        try {
          started = performance.now();
          const loaded = await loadEntries(room.baseUrl, current.modules, 6);
          const mismatched = loaded.filter((item) => item.status !== 200 || item.hash !== item.entry.sha256);
          modulesMatched = loaded.length - mismatched.length;
          modules = sourcesOf(loaded);
          return {
            verdict: mismatched.length === 0 ? "pass" : "FAIL",
            detail: summarize(loaded, mismatched, performance.now() - started)
          };
        } catch (error) {
          return { verdict: "FAIL", detail: `モジュールの取得に失敗: ${describeError(error)}` };
        }
      });
      if (modulesResult.verdict !== "pass")
        modules = [];
      libTotal = current.lib.length;
      await runner.run(meta(room, "s1-lib"), 15000, async () => {
        const started = performance.now();
        try {
          const loaded = await loadEntries(room.baseUrl, current.lib, 3);
          const mismatched = loaded.filter((item) => item.status !== 200 || item.hash !== item.entry.sha256);
          libMatched = loaded.length - mismatched.length;
          libThree = loaded.find((item) => item.entry.name === "three" && item.text !== undefined)?.text;
          const three = loaded.find((item) => item.entry.name === "three");
          const threeText = three === undefined ? " three=無し" : ` three=${formatBytes(three.bytes)}`;
          return {
            verdict: mismatched.length === 0 ? "pass" : "FAIL",
            detail: `${summarize(loaded, mismatched, performance.now() - started)}${threeText}`
          };
        } catch (error) {
          return { verdict: "FAIL", detail: `lib の取得に失敗: ${describeError(error)}` };
        }
      });
    }
    const bulkResult = await runner.run(meta(room, "s1-bulk"), 120000, async () => {
      const outcome = await probeBulk(room);
      return { verdict: outcome.verdict, detail: outcome.detail };
    });
    const allPassed = current !== undefined && manifestResult.verdict === "pass" && modulesMatched === modulesTotal && libMatched === libTotal && bulkResult.verdict === "pass";
    const note = `S1 ${room.label}: manifest=${manifestResult.verdict} ` + `modules=${modulesMatched}/${modulesTotal} lib=${libMatched}/${libTotal} bulk=${bulkResult.verdict}`;
    return {
      room,
      allPassed,
      ...current === undefined ? {} : { manifest: current },
      modules,
      ...libThree === undefined ? {} : { libThree },
      note
    };
  };

  // src/outer/s2.ts
  var PROBE_IDS = [
    "s2-fetch-cors",
    "s2-fetch-nocors",
    "s2-xhr",
    "s2-import-room",
    "s2-import-viewer",
    "s2-importscripts",
    "s2-worker",
    "s2-websocket",
    "s2-eventsource",
    "s2-beacon"
  ];
  var NO_ROOM = "S1 が通った部屋が無いため実行していない";
  var openedOrBlocked = (value, detail) => value.opened === true ? { verdict: "FAIL", detail: `open してしまった: ${detail}` } : { verdict: "pass", detail };
  var judgeProbe = (id, raw) => {
    const value = asRecord(raw);
    if (value === undefined)
      return { verdict: "FAIL", detail: "probe の結果がオブジェクトでない" };
    if (value.status === "timeout")
      return { verdict: "error", detail: "5秒で決着しなかった" };
    const detail = typeof value.detail === "string" ? value.detail : "(説明なし)";
    if (typeof value.reached !== "boolean") {
      return { verdict: "FAIL", detail: `probe の結果の形が不正: ${detail}` };
    }
    if (id === "s2-beacon") {
      if (value.present !== true)
        return { verdict: "pass", detail: "sendBeacon が無い" };
      return { verdict: "info", detail: `${detail}（呼んでみた結果）` };
    }
    if (id === "s2-websocket" || id === "s2-eventsource")
      return openedOrBlocked(value, detail);
    return value.reached ? { verdict: "FAIL", detail: `届いてしまった: ${detail}` } : { verdict: "pass", detail };
  };
  var meta2 = (room, id) => ({
    section: "S2",
    id,
    ...room === undefined ? {} : { source: room.room.label },
    expect: "pass"
  });
  var runS2 = async (runner, frame, room) => {
    if (room === undefined || room.manifest === undefined) {
      for (const id of PROBE_IDS) {
        await runner.run(meta2(room, id), 1e4, async () => ({ verdict: "FAIL", detail: NO_ROOM }));
      }
      return;
    }
    const manifestUrl = urlInRoom(room.room.baseUrl, "manifest.json");
    const moduleUrl = urlInRoom(room.room.baseUrl, "modules/c.js");
    const viewerUrl = viewerScriptUrl(location.href);
    for (const id of PROBE_IDS) {
      await runner.run(meta2(room, id), 9000, async () => {
        try {
          const value = await frame.call("net-probe", { id, target: probeTarget(manifestUrl, id), moduleUrl, viewerUrl }, 6000);
          return judgeProbe(id, value);
        } catch (error) {
          const detail = describeError(error);
          return detail.includes("時間切れ") ? { verdict: "error", detail } : { verdict: "FAIL", detail };
        }
      });
    }
  };

  // src/outer/s2c.ts
  var CONTROL_TIMEOUT_MS = 1e4;
  var KEYS = ["fetch-cors", "fetch-nocors", "xhr", "import-room"];
  var NO_ROOM2 = "S1 が通った部屋が無いため実行していない";
  var isModuleContentType = (contentType) => /javascript|ecmascript/i.test(contentType);
  var fail2 = (detail) => ({ verdict: "FAIL", detail });
  var judgeControl = (key, raw) => {
    const value = asRecord(raw);
    if (value === undefined)
      return fail2(`対照の結果が無い（${key}）`);
    const detail = typeof value.detail === "string" ? value.detail : "(説明なし)";
    if (key === "fetch-cors") {
      const status = typeof value.status === "number" ? value.status : 0;
      const jsonOk = value.jsonOk === true;
      if (value.reached === true && status === 200 && jsonOk) {
        return { verdict: "pass", detail: `届いた status=${status} JSON=読めた` };
      }
      return fail2(`届かないか JSON にできない: ${detail}`);
    }
    if (key === "fetch-nocors") {
      return value.reached === true ? { verdict: "pass", detail: `届いた ${detail}` } : fail2(`届かなかった: ${detail}`);
    }
    if (key === "xhr") {
      const status = typeof value.status === "number" ? value.status : 0;
      return status === 200 ? { verdict: "pass", detail: `届いた status=${status}` } : fail2(`届かなかった: ${detail}`);
    }
    const imported = value.importOk === true;
    const contentType = typeof value.contentType === "string" ? value.contentType : "";
    const exportsList = Array.isArray(value.exports) ? value.exports.filter((item) => typeof item === "string") : [];
    if (imported && exportsList.length > 0) {
      return { verdict: "pass", detail: `読み込めた exports=${exportsList.join(",")}` };
    }
    if (imported)
      return fail2("読み込めたが export が取れない");
    if (contentType !== "" && !isModuleContentType(contentType)) {
      return { verdict: "info", detail: `content-type=${contentType} のため読めない: ${detail}` };
    }
    return fail2(`読み込めなかった: ${detail}`);
  };
  var openControl = (target, moduleUrl) => new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.title = "隔離なしの対照";
    iframe.style.cssText = "position:absolute;width:0;height:0;border:0;left:-9999px";
    const url = new URL("control.html", location.href);
    url.searchParams.set("target", target);
    url.searchParams.set("module", moduleUrl);
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      iframe.remove();
    };
    const onMessage = (event) => {
      if (event.source !== iframe.contentWindow)
        return;
      if (event.origin !== location.origin)
        return;
      const data = asRecord(event.data);
      if (data === undefined || data.type !== "control-results")
        return;
      const results = asRecord(data.results);
      if (results === undefined)
        return;
      cleanup();
      resolve(results);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("隔離なしの対照から結果が来ない（10秒）"));
    }, CONTROL_TIMEOUT_MS);
    window.addEventListener("message", onMessage);
    iframe.src = url.href;
    document.body.append(iframe);
  });
  var readControl = async (room) => {
    if (room === undefined || room.manifest === undefined) {
      return { results: undefined, failure: NO_ROOM2 };
    }
    const manifestUrl = urlInRoom(room.room.baseUrl, "manifest.json");
    const moduleUrl = urlInRoom(room.room.baseUrl, "modules/c.js");
    try {
      const results = await openControl(probeTarget(manifestUrl, "s2c"), moduleUrl);
      return { results, failure: "" };
    } catch (error) {
      return { results: undefined, failure: describeError(error) };
    }
  };
  var meta3 = (room, id) => ({
    section: "S2c",
    id,
    ...room === undefined ? {} : { source: room.room.label },
    expect: "pass"
  });
  var runS2c = async (runner, room) => {
    const control = await readControl(room);
    for (const key of KEYS) {
      await runner.run(meta3(room, `s2c-${key}`), 12000, async () => {
        if (control.results === undefined)
          return fail2(control.failure);
        return judgeControl(key, control.results[`s2c-${key}`]);
      });
    }
  };

  // src/outer/s4.ts
  var parseAttempts = (value) => {
    if (!Array.isArray(value))
      return [];
    const attempts = [];
    for (const item of value) {
      const record2 = asRecord(item);
      if (record2 === undefined)
        continue;
      attempts.push({
        group: typeof record2.group === "string" ? record2.group : "?",
        label: typeof record2.label === "string" ? record2.label : "?",
        status: typeof record2.status === "string" ? record2.status : "?",
        detail: typeof record2.detail === "string" ? record2.detail : ""
      });
    }
    return attempts;
  };
  var judgeRecover = (raw) => {
    const value = asRecord(raw);
    const attempts = parseAttempts(value?.attempts);
    if (attempts.length === 0)
      return { verdict: "FAIL", detail: "取り戻しの記録が来ない" };
    const recovered = attempts.filter((attempt2) => attempt2.status === "recovered");
    const names = recovered.map((attempt2) => attempt2.label);
    const detail = `手口=${attempts.length} 取り戻せた=${recovered.length} ` + `名前=${names.join(",") || "なし"}`;
    return recovered.length === 0 ? { verdict: "pass", detail } : { verdict: "FAIL", detail: `${detail}（取り戻せてはいけない）` };
  };
  var runS4 = async (runner, frame) => {
    await runner.run({ section: "S4", id: "s4-recover", expect: "pass" }, 25000, async () => {
      try {
        const value = await frame.call("recover", {}, 22000);
        return judgeRecover(value);
      } catch (error) {
        return { verdict: "FAIL", detail: describeError(error) };
      }
    });
  };

  // src/outer/s5.ts
  var NO_ROOM3 = "S1 が通った部屋が無いため実行していない";
  var readValues = async (frame, modules, entry) => {
    const result = asRecord(await frame.call("load", { modules, entry }, 14000));
    const values = asRecord(result?.values);
    if (values === undefined)
      throw new Error("枠から値が来ない");
    return values;
  };
  var textOf = (value) => typeof value === "string" ? value : "(なし)";
  var runS5 = async (runner, frame, room) => {
    const source = room === undefined ? undefined : room.room.label;
    const meta4 = (id) => ({
      section: "S5",
      id,
      ...source === undefined ? {} : { source },
      expect: "pass"
    });
    if (room === undefined || room.manifest === undefined || room.modules.length === 0) {
      for (const id of ["s5-static", "s5-runtime", "s5-external"]) {
        await runner.run(meta4(id), 15000, async () => ({ verdict: "FAIL", detail: NO_ROOM3 }));
      }
      return;
    }
    const { modules, manifest } = room;
    const entry = manifest.entry;
    await runner.run(meta4("s5-static"), 15000, async () => {
      try {
        const values = await readValues(frame, modules, entry);
        const actual = textOf(values.result);
        return actual === "a=7 b=6" ? { verdict: "pass", detail: `result=${actual}` } : { verdict: "FAIL", detail: `期待 a=7 b=6 / 実際 ${actual}` };
      } catch (error) {
        return { verdict: "FAIL", detail: describeError(error) };
      }
    });
    await runner.run(meta4("s5-runtime"), 15000, async () => {
      try {
        const values = await readValues(frame, modules, entry);
        const actual = textOf(values.runtime);
        return actual === "d=42" ? { verdict: "pass", detail: `runtime=${actual}` } : { verdict: "FAIL", detail: `期待 d=42 / 実際 ${actual}` };
      } catch (error) {
        return { verdict: "FAIL", detail: describeError(error) };
      }
    });
    await runner.run(meta4("s5-external"), 15000, async () => {
      const target = urlInRoom(room.room.baseUrl, "manifest.json");
      const sourceText = [
        `const target = ${JSON.stringify(target)};`,
        "export const result = await (async () => {",
        "  try {",
        "    await import(target);",
        '    return "loaded";',
        "  } catch (error) {",
        '    return "blocked:" + (error && error.name ? error.name : "Error");',
        "  }",
        "})();"
      ].join(`
`);
      try {
        const values = await readValues(frame, [...modules, { name: "external-entry", source: sourceText }], "external-entry");
        const actual = textOf(values.result);
        return actual.startsWith("blocked") ? { verdict: "pass", detail: `遮断 ${actual}` } : { verdict: "FAIL", detail: `外部のモジュールを読めてしまった ${actual}` };
      } catch (error) {
        return { verdict: "FAIL", detail: `外部の読み込みの結果が来ない: ${describeError(error)}` };
      }
    });
  };

  // src/outer/s6.ts
  var pixelText = (value) => {
    if (!Array.isArray(value))
      return "(なし)";
    return value.map((item) => typeof item === "number" ? item : "?").join(",");
  };
  var probe = async (frame, method) => {
    try {
      const value = asRecord(await frame.call(method, {}, 13000));
      if (value === undefined)
        return { verdict: "FAIL", detail: "枠から値が来ない" };
      const pixel = `pixel=${pixelText(value.pixel)}`;
      if (value.ok !== true)
        return { verdict: "FAIL", detail: `色が一致しない ${pixel}` };
      return {
        verdict: "pass",
        detail: value.kind === "webgl2" ? `${pixel} version=${String(value.version)}` : pixel
      };
    } catch (error) {
      return { verdict: "FAIL", detail: describeError(error) };
    }
  };
  var runS6 = async (runner, frame, room) => {
    const source = room === undefined ? undefined : room.room.label;
    const meta4 = (id) => ({
      section: "S6",
      id,
      ...source === undefined ? {} : { source },
      expect: "pass"
    });
    await runner.run(meta4("s6-offscreen-2d"), 15000, async () => await probe(frame, "render-2d"));
    await runner.run(meta4("s6-offscreen-webgl2"), 15000, async () => await probe(frame, "render-webgl2"));
    await runner.run(meta4("s6-transfer"), 15000, async () => {
      try {
        const value = asRecord(await frame.call("render-transfer", {}, 14000));
        const frames = typeof value?.frames === "number" ? value.frames : 0;
        const size = `${String(value?.width ?? "?")}x${String(value?.height ?? "?")}`;
        return frames >= 1 ? { verdict: "pass", detail: `コマ数=${frames} 大きさ=${size}` } : { verdict: "FAIL", detail: `描けたコマ数=${frames}` };
      } catch (error) {
        return { verdict: "FAIL", detail: describeError(error) };
      }
    });
    await runner.run(meta4("s6-three"), 15000, async () => {
      if (room === undefined || room.libThree === undefined) {
        return { verdict: "FAIL", detail: "three のソースがある部屋が無いため実行していない" };
      }
      try {
        const value = asRecord(await frame.call("render-three", { threeSource: room.libThree }, 14500));
        const frames = typeof value?.frames === "number" ? value.frames : 0;
        const differs = value?.differs === true;
        const detail = `コマ数=${frames} context=${String(value?.context)} ` + `中央=${pixelText(value?.center)} 隅=${pixelText(value?.corner)}`;
        if (frames < 1)
          return { verdict: "FAIL", detail: `描けたコマ数=${frames}` };
        if (!differs)
          return { verdict: "FAIL", detail: `中央が背景色と同じ ${detail}` };
        return { verdict: "pass", detail };
      } catch (error) {
        return { verdict: "FAIL", detail: describeError(error) };
      }
    });
  };

  // src/shared/heartbeat.ts
  var round12 = (value) => Math.round(value * 10) / 10;
  var maxGapOf = (times) => {
    let max = 0;
    for (let index = 1;index < times.length; index += 1) {
      const previous = times[index - 1];
      const current = times[index];
      if (previous === undefined || current === undefined)
        continue;
      max = Math.max(max, current - previous);
    }
    return max;
  };
  var startHeartbeat = (intervalMs) => {
    const times = [];
    const start = performance.now();
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped)
        return;
      times.push(performance.now());
    }, intervalMs);
    return {
      report: () => ({
        maxGapMs: round12(maxGapOf(times)),
        samples: times.length,
        elapsedMs: round12(performance.now() - start),
        intervalMs
      }),
      stop: () => {
        stopped = true;
        clearInterval(timer);
      }
    };
  };

  // src/outer/s7.ts
  var numberOrZero = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
  var loopTest = async (frame) => {
    const heartbeat = startHeartbeat(50);
    try {
      const value = asRecord(await frame.call("spin", {}, 18000));
      const report = heartbeat.report();
      const stopped = value?.stopped === true;
      const echoOk = value?.echoOk === true;
      const terminateMs = numberOrZero(value?.terminateMs);
      const gap = report.maxGapMs;
      const detail = `停止まで=${formatMs(terminateMs)} 新しいWorker=${echoOk ? "通った" : "失敗"} ` + `心拍の最大の間隔=${formatMs(gap)}`;
      if (!stopped)
        return { verdict: "FAIL", detail: `止まらなかった ${detail}` };
      if (!echoOk)
        return { verdict: "FAIL", detail: `止めたあとの仕事が通らない ${detail}` };
      if (gap >= 500)
        return { verdict: "FAIL", detail: `外側のページが固まった ${detail}` };
      return { verdict: "pass", detail };
    } catch (error) {
      return { verdict: "FAIL", detail: describeError(error) };
    } finally {
      heartbeat.stop();
    }
  };
  var floodTest = async (frame) => {
    try {
      const value = asRecord(await frame.call("flood", {}, 15000));
      const received = numberOrZero(value?.received);
      const limitMs = numberOrZero(value?.limitMs);
      const detail = `受け取った通数=${received} 停止まで=${formatMs(limitMs)} 理由=${String(value?.reason ?? "?")}`;
      return value?.stopped === true ? { verdict: "pass", detail } : { verdict: "FAIL", detail: `止まらなかった ${detail}` };
    } catch (error) {
      return { verdict: "FAIL", detail: describeError(error) };
    }
  };
  var runS7 = async (runner, frame) => {
    await runner.run({ section: "S7", id: "s7-loop", expect: "pass" }, 27000, async () => loopTest(frame));
    await runner.run({ section: "S7", id: "s7-flood", expect: "pass" }, 20000, async () => floodTest(frame));
  };

  // src/outer/s8.ts
  var WAIT_MS = 3000;
  var probeUnsandboxed = () => new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.title = "隔離なしの枠";
    iframe.style.cssText = "position:absolute;width:0;height:0;border:0;left:-9999px";
    let refused = false;
    let ready = false;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      iframe.remove();
    };
    const finish = (verdict) => {
      if (settled)
        return;
      settled = true;
      cleanup();
      resolve(verdict);
    };
    const onMessage = (event) => {
      if (event.source !== iframe.contentWindow)
        return;
      const data = asRecord(event.data);
      if (data === undefined)
        return;
      if (data.type === "ready") {
        ready = true;
        finish({ verdict: "FAIL", detail: "隔離なしなのに ready が来た" });
        return;
      }
      if (data.type === "refused")
        refused = true;
    };
    const timer = setTimeout(() => {
      if (refused && !ready) {
        finish({ verdict: "pass", detail: "3秒以内に refused が来て、ready は来なかった" });
        return;
      }
      finish({
        verdict: "FAIL",
        detail: `refused=${refused ? "来た" : "来ない"} ready=${ready ? "来た" : "来ない"}`
      });
    }, WAIT_MS);
    window.addEventListener("message", onMessage);
    iframe.src = new URL("frame.html", location.href).href;
    document.body.append(iframe);
  });
  var runS8 = async (runner) => {
    await runner.run({ section: "S8", id: "s8-unsandboxed", expect: "pass" }, 1e4, async () => await probeUnsandboxed());
  };

  // src/shared/compare.ts
  var PAIRS = [
    { key: "fetch-cors", label: "fetch（CORS）" },
    { key: "fetch-nocors", label: "fetch（no-cors）" },
    { key: "xhr", label: "XMLHttpRequest" },
    { key: "import-room", label: "import（部屋のモジュール）" }
  ];
  var verdictOf = (rows, id) => rows.find((row) => row.id === id)?.verdict ?? "none";
  var buildComparison = (rows) => PAIRS.map((pair) => ({
    key: pair.key,
    label: pair.label,
    isolated: verdictOf(rows, `s2-${pair.key}`),
    control: verdictOf(rows, `s2c-${pair.key}`)
  }));

  // src/shared/summary.ts
  var countRows = (rows) => ({
    pass: rows.filter((row) => row.verdict === "pass").length,
    fail: rows.filter((row) => row.verdict === "FAIL" || row.verdict === "error").length,
    info: rows.filter((row) => row.verdict === "info").length
  });
  var failureIds = (rows) => rows.filter((row) => row.verdict === "FAIL" || row.verdict === "error").map((row) => row.id);

  // src/outer/ui.ts
  var requireElement = (id) => {
    const element = document.getElementById(id);
    if (element === null)
      throw new Error(`画面の部品が無い: ${id}`);
    return element;
  };
  var cell = (text) => {
    const element = document.createElement("td");
    element.textContent = text;
    return element;
  };
  var isolatedText = (verdict) => {
    if (verdict === "none")
      return "—";
    if (verdict === "pass")
      return "届かない";
    if (verdict === "FAIL" || verdict === "error")
      return "届いた扱い";
    return "記録";
  };
  var controlText = (verdict) => {
    if (verdict === "none")
      return "—";
    if (verdict === "pass")
      return "届いた";
    if (verdict === "FAIL" || verdict === "error")
      return "届かない扱い";
    return "記録";
  };
  var createUi = () => {
    const status = requireElement("status");
    const problems = requireElement("problems");
    const rowsBody = requireElement("rows");
    const failures = requireElement("failures");
    const notes = requireElement("notes");
    const json = requireElement("json");
    const compareBody = requireElement("compare");
    const compareNote = requireElement("compare-note");
    const embedLink2 = document.getElementById("embed-link");
    let current = [];
    const setStatus = (text, tone = "idle") => {
      status.textContent = text;
      status.dataset.tone = tone;
    };
    const showProblems = (lines) => {
      problems.replaceChildren();
      for (const line of lines) {
        const paragraph = document.createElement("p");
        paragraph.textContent = line;
        problems.append(paragraph);
      }
    };
    const setEmbedLink = (href) => {
      if (embedLink2 === null)
        return;
      if (href === undefined) {
        embedLink2.removeAttribute("href");
        embedLink2.hidden = true;
        return;
      }
      embedLink2.href = href;
      embedLink2.hidden = false;
    };
    const renderCompare = (rows) => {
      const entries = buildComparison(rows);
      compareBody.replaceChildren();
      for (const entry of entries) {
        const tr = document.createElement("tr");
        tr.append(cell(entry.label), cell(isolatedText(entry.isolated)), cell(controlText(entry.control)));
        compareBody.append(tr);
      }
      const missing = entries.some((entry) => entry.isolated === "none" || entry.control === "none");
      compareNote.textContent = missing ? "S2 または S2c が実行されていない行があります。" : "隔離ありの「届かない」と、隔離なしの「届いた」が並んでいれば、遮断は隔離のおかげです。";
    };
    const addRow = (row) => {
      current = [...current, row];
      const tr = document.createElement("tr");
      tr.dataset.verdict = row.verdict;
      tr.append(cell(row.section), cell(row.id), cell(row.source ?? ""), cell(row.expect === "pass" ? "合格" : "記録"), cell(row.verdict), cell(row.detail), cell(row.ms === undefined ? "" : String(row.ms)));
      rowsBody.append(tr);
      const counts = countRows(current);
      setStatus(`実行中… 合格 ${counts.pass} ／ 不合格 ${counts.fail} ／ 記録 ${counts.info}`);
    };
    const finish = (results, noteLines) => {
      const counts = countRows(results.rows);
      setStatus(`完了：合格 ${counts.pass} ／ 不合格 ${counts.fail} ／ 記録 ${counts.info}`, counts.fail === 0 ? "ok" : "bad");
      const failed = failureIds(results.rows);
      failures.textContent = failed.length === 0 ? "不合格なし" : `不合格: ${failed.join(", ")}`;
      notes.textContent = noteLines.join(`
`);
      renderCompare(results.rows);
      json.value = JSON.stringify(results, null, 2);
    };
    return { setStatus, showProblems, setEmbedLink, addRow, finish };
  };

  // src/outer/outer.ts
  var startedAt = new Date().toISOString();
  var refuseEmbedded = () => {
    const results = {
      userAgent: navigator.userAgent,
      startedAt,
      finished: true,
      refused: "embedded",
      rows: []
    };
    Reflect.set(window, "__results", results);
    document.body.textContent = "ほかのサイトに埋め込まれているので動きません";
  };
  var main = async () => {
    const ui = createUi();
    const runner = createRunner(ui);
    const roomArgs = parseRoomArgs(new URLSearchParams(location.search).getAll("room"));
    let finished = false;
    const publish = () => {
      const results = {
        userAgent: navigator.userAgent,
        startedAt,
        finished,
        rows: runner.rows()
      };
      Reflect.set(window, "__results", results);
      return results;
    };
    const finish = () => {
      finished = true;
      const results = publish();
      ui.finish(results, runner.notes());
    };
    try {
      ui.setStatus("準備中");
      ui.showProblems(roomArgs.problems);
      const firstRoom = roomArgs.rooms[0];
      ui.setEmbedLink(firstRoom === undefined ? undefined : embedLink(firstRoom.baseUrl, location.href));
      if (roomArgs.rooms.length === 0) {
        ui.setStatus("部屋の指定がありません", "bad");
        ui.showProblems([...USAGE_LINES, ...roomArgs.problems]);
        runner.note("部屋が無いため試験を実行していない");
        finish();
        return;
      }
      let frame;
      try {
        frame = await connectFrame();
      } catch (error) {
        const detail = describeError(error);
        ui.showProblems([...roomArgs.problems, `枠につながらない: ${detail}`]);
        runner.note(`枠につながらない: ${detail}`);
        frame = missingFrame(detail);
      }
      await runS0(runner, frame);
      const outcomes = [];
      for (const room of roomArgs.rooms) {
        const outcome = await runRoomS1(room, runner);
        outcomes.push(outcome);
        runner.note(outcome.note);
      }
      const chosen = outcomes.find((outcome) => outcome.allPassed);
      runner.note(chosen === undefined ? "S2/S5/S6: S1 が通った部屋が無い" : `S2/S5/S6: ${chosen.room.label} を使う`);
      await runS5(runner, frame, chosen);
      await runS6(runner, frame, chosen);
      await runS2(runner, frame, chosen);
      await runS2c(runner, chosen);
      await runS4(runner, frame);
      runner.note("S4: 鍵を掛けた Worker の中の訪問者役が、消した入口を取り戻せるかを見た");
      await runS7(runner, frame);
      await runS8(runner);
    } catch (error) {
      const detail = describeError(error);
      ui.showProblems([...roomArgs.problems, `想定外の失敗: ${detail}`]);
      runner.note(`想定外の失敗: ${detail}`);
    }
    finish();
  };
  if (window.top !== window.self) {
    refuseEmbedded();
  } else {
    main().catch((error) => {
      document.body.textContent = `起動に失敗: ${describeError(error)}`;
    });
  }
})();
