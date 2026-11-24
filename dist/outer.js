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
    const record = asRecord(value);
    if (record === undefined)
      return;
    const { name, path, sha256, bytes } = record;
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
    const record = asRecord(value);
    if (record === undefined)
      return;
    if (record.format !== 1)
      return;
    if (typeof record.entry !== "string" || record.entry === "")
      return;
    const modules = parseList(record.modules);
    const lib = parseList(record.lib);
    if (modules === undefined || lib === undefined)
      return;
    const names = new Set;
    for (const entry of [...modules, ...lib]) {
      if (names.has(entry.name))
        return;
      names.add(entry.name);
    }
    if (!modules.some((entry) => entry.name === record.entry))
      return;
    return { format: 1, entry: record.entry, modules, lib };
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
      const record = item;
      const { path, sha256, bytes } = record;
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

  // src/outer/s5.ts
  var NO_ROOM = "S1 が通った部屋が無いため実行していない";
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
    const meta2 = (id) => ({
      section: "S5",
      id,
      ...source === undefined ? {} : { source },
      expect: "pass"
    });
    if (room === undefined || room.manifest === undefined || room.modules.length === 0) {
      for (const id of ["s5-static", "s5-runtime", "s5-external"]) {
        await runner.run(meta2(id), 15000, async () => ({ verdict: "FAIL", detail: NO_ROOM }));
      }
      return;
    }
    const { modules, manifest } = room;
    const entry = manifest.entry;
    await runner.run(meta2("s5-static"), 15000, async () => {
      try {
        const values = await readValues(frame, modules, entry);
        const actual = textOf(values.result);
        return actual === "a=7 b=6" ? { verdict: "pass", detail: `result=${actual}` } : { verdict: "FAIL", detail: `期待 a=7 b=6 / 実際 ${actual}` };
      } catch (error) {
        return { verdict: "FAIL", detail: describeError(error) };
      }
    });
    await runner.run(meta2("s5-runtime"), 15000, async () => {
      try {
        const values = await readValues(frame, modules, entry);
        const actual = textOf(values.runtime);
        return actual === "d=42" ? { verdict: "pass", detail: `runtime=${actual}` } : { verdict: "FAIL", detail: `期待 d=42 / 実際 ${actual}` };
      } catch (error) {
        return { verdict: "FAIL", detail: describeError(error) };
      }
    });
    await runner.run(meta2("s5-external"), 15000, async () => {
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
    const meta2 = (id) => ({
      section: "S6",
      id,
      ...source === undefined ? {} : { source },
      expect: "pass"
    });
    await runner.run(meta2("s6-offscreen-2d"), 15000, async () => await probe(frame, "render-2d"));
    await runner.run(meta2("s6-offscreen-webgl2"), 15000, async () => await probe(frame, "render-webgl2"));
    await runner.run(meta2("s6-transfer"), 15000, async () => {
      try {
        const value = asRecord(await frame.call("render-transfer", {}, 14000));
        const frames = typeof value?.frames === "number" ? value.frames : 0;
        const size = `${String(value?.width ?? "?")}x${String(value?.height ?? "?")}`;
        return frames >= 1 ? { verdict: "pass", detail: `コマ数=${frames} 大きさ=${size}` } : { verdict: "FAIL", detail: `描けたコマ数=${frames}` };
      } catch (error) {
        return { verdict: "FAIL", detail: describeError(error) };
      }
    });
    await runner.run(meta2("s6-three"), 15000, async () => {
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
  var createUi = () => {
    const status = requireElement("status");
    const problems = requireElement("problems");
    const rowsBody = requireElement("rows");
    const failures = requireElement("failures");
    const notes = requireElement("notes");
    const json = requireElement("json");
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
    const addRow = (row) => {
      current = [...current, row];
      const tr = document.createElement("tr");
      tr.dataset.verdict = row.verdict;
      tr.append(cell(row.section), cell(row.id), cell(row.source ?? ""), cell(row.expect === "pass" ? "合格" : "記録"), cell(row.verdict), cell(row.detail), cell(row.ms === undefined ? "" : String(row.ms)));
      rowsBody.append(tr);
      const counts = countRows(current);
      setStatus(`合格 ${counts.pass} ／ 不合格 ${counts.fail} ／ 記録 ${counts.info}`);
    };
    const finish = (results, noteLines) => {
      const counts = countRows(results.rows);
      setStatus(`合格 ${counts.pass} ／ 不合格 ${counts.fail} ／ 記録 ${counts.info}`, counts.fail === 0 ? "ok" : "bad");
      const failed = failureIds(results.rows);
      failures.textContent = failed.length === 0 ? "不合格なし" : `不合格: ${failed.join(", ")}`;
      notes.textContent = noteLines.join(`
`);
      json.value = JSON.stringify(results, null, 2);
    };
    return { setStatus, showProblems, addRow, finish };
  };

  // src/outer/outer.ts
  var ui = createUi();
  var runner = createRunner(ui);
  var startedAt = new Date().toISOString();
  var finished = false;
  var publish = () => {
    const results = {
      userAgent: navigator.userAgent,
      startedAt,
      finished,
      rows: runner.rows()
    };
    Reflect.set(window, "__results", results);
    return results;
  };
  var finish = () => {
    finished = true;
    const results = publish();
    ui.finish(results, runner.notes());
  };
  var roomArgs = parseRoomArgs(new URLSearchParams(location.search).getAll("room"));
  var main = async () => {
    ui.setStatus("準備中");
    ui.showProblems(roomArgs.problems);
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
    try {
      await runS0(runner, frame);
      const outcomes = [];
      for (const room of roomArgs.rooms) {
        const outcome = await runRoomS1(room, runner);
        outcomes.push(outcome);
        runner.note(outcome.note);
      }
      const chosen = outcomes.find((outcome) => outcome.allPassed);
      runner.note(chosen === undefined ? "S5/S6: S1 が通った部屋が無い" : `S5/S6: ${chosen.room.label} を使う`);
      await runS5(runner, frame, chosen);
      await runS6(runner, frame, chosen);
    } catch (error) {
      const detail = describeError(error);
      ui.showProblems([...roomArgs.problems, `想定外の失敗: ${detail}`]);
      runner.note(`想定外の失敗: ${detail}`);
    }
    finish();
  };
  main().catch((error) => {
    const detail = describeError(error);
    ui.showProblems([...roomArgs.problems, `起動に失敗: ${detail}`]);
    runner.note(`起動に失敗: ${detail}`);
    finish();
  });
})();
