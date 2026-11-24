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
  var sha256Hex = async (source) => {
    if (crypto.subtle === undefined)
      throw new Error("crypto.subtle が無い");
    const digest = await crypto.subtle.digest("SHA-256", source);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  var urlInRoom = (baseUrl, path) => new URL(path, baseUrl).href;

  // src/shared/marker.ts
  var BOT_LOGIN = "github-actions[bot]";
  var MARKER_LINE = /^<!-- jamroom-check v1 code=([a-z][a-z-]*) sha256=([0-9a-f]{64}|-) name=([a-z][a-z0-9-]{0,39}|-) -->$/gm;
  var findMarker = (body) => {
    let found;
    for (const match of body.matchAll(MARKER_LINE)) {
      const code = match[1];
      if (code === undefined)
        continue;
      const sha256 = match[2];
      const name = match[3];
      found = {
        code,
        ...sha256 === undefined || sha256 === "-" ? {} : { sha256 },
        ...name === undefined || name === "-" ? {} : { name }
      };
    }
    return found;
  };
  var parseComments = (value) => {
    if (!Array.isArray(value))
      return [];
    const comments = [];
    for (const item of value) {
      const record = asRecord(item);
      if (record === undefined)
        continue;
      const body = record["body"];
      if (typeof body !== "string")
        continue;
      const user = asRecord(record["user"]);
      const login = user?.["login"];
      const type = user?.["type"];
      comments.push({
        body,
        user: {
          ...typeof login === "string" ? { login: login.slice(0, 100) } : {},
          ...typeof type === "string" ? { type: type.slice(0, 40) } : {}
        }
      });
    }
    return comments;
  };
  var lastBotCommentBody = (comments) => {
    let body;
    for (const comment of comments) {
      if (comment.user?.login !== BOT_LOGIN)
        continue;
      if (comment.user?.type !== "Bot")
        continue;
      body = comment.body;
    }
    return body;
  };
  var readMarker = (comments) => {
    const body = lastBotCommentBody(comments);
    return body === undefined ? undefined : findMarker(body);
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

  // src/shared/preview-args.ts
  var DEFAULT_API_BASE = "https://api.github.com";
  var REPO_PATTERN = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
  var ISSUE_PATTERN = /^[1-9][0-9]{0,8}$/;
  var parseApiBase = (raw) => {
    if (raw === null || !raw.startsWith("http://127.0.0.1:"))
      return;
    let url;
    try {
      url = new URL(raw);
    } catch {
      return;
    }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
      return;
    if (url.username !== "" || url.password !== "")
      return;
    if (url.pathname !== "/" && url.pathname !== "")
      return;
    if (url.search !== "" || url.hash !== "")
      return;
    if (!/^[0-9]{1,5}$/.test(url.port))
      return;
    const port = Number(url.port);
    if (port < 1 || port > 65535)
      return;
    return `http://127.0.0.1:${port}`;
  };
  var parsePreviewArgs = (params) => {
    const problems = [];
    const roomArgs = parseRoomArgs(params.getAll("room"));
    problems.push(...roomArgs.problems);
    const room = roomArgs.rooms[0];
    if (room === undefined) {
      problems.push("room の指定がありません");
    } else if (roomArgs.rooms.length > 1) {
      problems.push("room は1つだけにしてください");
    }
    const repo = params.get("repo");
    if (repo === null || !REPO_PATTERN.test(repo)) {
      problems.push(`repo は <owner>/<repo> の形にしてください（${repo ?? "指定なし"}）`);
    }
    const issueText = params.get("issue");
    if (issueText === null || !ISSUE_PATTERN.test(issueText)) {
      problems.push(`issue は 1 以上の番号にしてください（${issueText ?? "指定なし"}）`);
    }
    if (problems.length > 0 || room === undefined || repo === null || issueText === null) {
      return { kind: "bad", problems };
    }
    return {
      kind: "ok",
      args: {
        room,
        repo,
        issue: Number(issueText),
        apiBase: parseApiBase(params.get("api")) ?? DEFAULT_API_BASE
      }
    };
  };
  var PREVIEW_USAGE_LINES = [
    "使い方: ?room=<ラベル>|<基底URL>&repo=<owner>/<repo>&issue=<番号>",
    "例: ?room=local|http://127.0.0.1:4331/&repo=local/room&issue=1&api=http://127.0.0.1:4332",
    "基底URLは https: か http://127.0.0.1 だけ。api は手元の予行演習用で、http://127.0.0.1:<ポート> のときだけ使います。"
  ];

  // src/shared/preview-result.ts
  var textOf = (value) => typeof value === "string" ? value : null;
  var viewOfPreviewResult = (result) => {
    const loadError = textOf(result["loadError"]);
    const describePresent = result["describePresent"] === true;
    const describeText = textOf(result["describeText"]);
    const describeError2 = textOf(result["describeError"]);
    const nothing = result["nothing"] === true;
    const drawPresent = result["drawPresent"] === true;
    const frames = typeof result["frames"] === "number" ? result["frames"] : 0;
    const drawError = textOf(result["drawError"]);
    const unsupported = textOf(result["drawUnsupported"]);
    const stopped = result["stopped"] === true;
    let errorLine = null;
    let describeTitle = "describe";
    let describeBody = "ありません";
    let framesText = "draw はありません";
    if (loadError !== null) {
      errorLine = `読み込みに失敗しました: ${loadError}`;
      describeBody = "—";
      framesText = "下見できません";
    } else if (nothing) {
      describeTitle = "describe / draw";
      describeBody = "describe も draw もありません";
    } else {
      if (describeError2 !== null) {
        describeTitle = "describe() の例外";
        describeBody = describeError2;
        errorLine = `describe() で例外: ${describeError2}`;
      } else if (describePresent) {
        describeTitle = "describe() の戻り値";
        describeBody = describeText === null || describeText === "" ? "（空）" : describeText;
      }
      if (drawPresent) {
        if (unsupported !== null)
          framesText = unsupported;
        else if (drawError !== null) {
          framesText = `draw() が例外で止まりました（${String(frames)} コマまで）`;
          errorLine = `draw() で例外: ${drawError}`;
        } else if (stopped) {
          framesText = `止めました（${String(frames)} コマまで）`;
          errorLine = "止めました";
        } else {
          framesText = `コマ数: ${String(frames)}`;
        }
      }
    }
    const statusText = stopped ? "下見を止めました" : errorLine !== null ? "下見が途中で止まりました" : "下見が終わりました";
    return {
      describeTitle,
      describeBody,
      framesText,
      errorLine,
      describe: describePresent ? describeText : null,
      frames: drawPresent || describePresent ? frames : null,
      stopped,
      statusText,
      tone: stopped || errorLine !== null ? "bad" : "ok"
    };
  };

  // src/shared/shape.ts
  var MAX_BODY_CHARS = 65536;
  var MAX_CODE_CHARS = 48000;
  var NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
  var isName = (value) => typeof value === "string" && NAME_PATTERN.test(value);
  var parseTitle = (title) => {
    const match = /^contribute: (.+)$/.exec(title.trim());
    return match?.[1];
  };
  var extractCodeBlock = (body) => {
    const blocks = [];
    let current;
    for (const raw of body.split(`
`)) {
      const line = raw.trim();
      if (current === undefined) {
        if (line === "```js") {
          current = [];
        }
      } else if (line === "```") {
        blocks.push(current.join(`
`));
        current = undefined;
      } else {
        current.push(raw);
      }
    }
    if (blocks.length === 0)
      return { kind: "none" };
    if (blocks.length > 1)
      return { kind: "many" };
    return { kind: "one", code: blocks[0] ?? "" };
  };
  var specifierPatterns = () => [
    /\bimport\s+(?:[^;'"]*?\s+from\s+)?(["'])([^"'\n]+)\1/g,
    /\bexport\s+(?:\*[^;'"]*?|\{[^}]*?\})\s*from\s*(["'])([^"'\n]+)\1/g
  ];
  var DYNAMIC_IMPORT = /\bimport\s*\(/;
  var ROOM_PREFIX = "room:";
  var depsOf = (code) => {
    const names = [];
    for (const pattern of specifierPatterns()) {
      for (const match of code.matchAll(pattern)) {
        const specifier = match[2];
        if (specifier === undefined || !specifier.startsWith(ROOM_PREFIX))
          continue;
        const name = specifier.slice(ROOM_PREFIX.length);
        if (name === "" || names.includes(name))
          continue;
        names.push(name);
      }
    }
    return names;
  };
  var checkImports = (code) => {
    if (DYNAMIC_IMPORT.test(code))
      return { kind: "bad" };
    for (const pattern of specifierPatterns()) {
      for (const match of code.matchAll(pattern)) {
        const specifier = match[2];
        if (specifier === undefined)
          continue;
        if (!specifier.startsWith(ROOM_PREFIX) || specifier.length === ROOM_PREFIX.length) {
          return { kind: "bad" };
        }
      }
    }
    return { kind: "ok", deps: depsOf(code) };
  };

  // src/shared/verdict.ts
  var VERDICT_LABELS = {
    ready: "下見してよい",
    stale: "検査のあとでコードが変わっている",
    "not-checked": "検査の印が無い",
    failed: "検査に通っていない",
    "shape-error": "形が整っていない",
    closed: "イシューが閉じている"
  };
  var verdictLabel = (verdict) => VERDICT_LABELS[verdict];
  var inspectContribution = (title, body) => {
    const name = parseTitle(title);
    if (name === undefined) {
      return { kind: "bad", reason: "題名が「contribute: <名前>」の形ではありません" };
    }
    if (!isName(name)) {
      return {
        kind: "bad",
        reason: "名前が使える形ではありません（小文字で始まり、小文字・数字・ハイフンだけ、40文字まで）"
      };
    }
    if (body.length > MAX_BODY_CHARS) {
      return { kind: "bad", reason: "本文が長すぎます" };
    }
    const block = extractCodeBlock(body);
    if (block.kind === "none") {
      return { kind: "bad", reason: "```js で始まるコードブロックがありません" };
    }
    if (block.kind === "many") {
      return { kind: "bad", reason: "```js のコードブロックが2つ以上あります" };
    }
    if (block.code.length > MAX_CODE_CHARS) {
      return { kind: "bad", reason: "コードが長すぎます" };
    }
    const imports = checkImports(block.code);
    if (imports.kind === "bad") {
      return { kind: "bad", reason: "読み込めるのは静的な room:<名前> だけです" };
    }
    return { kind: "ok", name, code: block.code };
  };
  var judgeContribution = (input) => {
    if (!input.shapeOk) {
      return { verdict: "shape-error", reasons: ["形の検査に通りません"] };
    }
    if (input.state !== "open") {
      return { verdict: "closed", reasons: [`イシューが ${input.state} です`] };
    }
    const marker = input.marker;
    if (marker === undefined) {
      return { verdict: "not-checked", reasons: ["bot のコメントに検査の印がありません"] };
    }
    if (marker.code !== "ok") {
      return { verdict: "failed", reasons: [`印の符号が ${marker.code} です`] };
    }
    if (marker.sha256 !== input.sha256) {
      return {
        verdict: "stale",
        reasons: ["印の sha256 が、いまのコードの SHA-256 と一致しません"]
      };
    }
    if (!input.labels.includes("check:ok")) {
      return { verdict: "not-checked", reasons: ["check:ok のラベルがありません"] };
    }
    return { verdict: "ready", reasons: ["形・印・ラベルが揃っています"] };
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

  // src/outer/preview-issue.ts
  var textOf2 = (value, limit) => typeof value === "string" ? value.slice(0, limit) : "";
  var labelsOf = (value) => {
    if (!Array.isArray(value))
      return [];
    const labels = [];
    for (const item of value) {
      if (typeof item === "string") {
        if (item !== "" && !labels.includes(item.slice(0, 60)))
          labels.push(item.slice(0, 60));
        continue;
      }
      const record = asRecord(item);
      const name = record?.["name"];
      if (typeof name === "string" && name !== "" && !labels.includes(name.slice(0, 60))) {
        labels.push(name.slice(0, 60));
      }
    }
    return labels.slice(0, 50);
  };
  var parseIssue = (value, fallbackNumber) => {
    const record = asRecord(value) ?? {};
    const number = record["number"];
    const user = asRecord(record["user"]);
    const login = user?.["login"];
    return {
      number: typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : fallbackNumber,
      state: textOf2(record["state"], 20) || "unknown",
      author: typeof login === "string" && login !== "" ? login.slice(0, 100) : "(不明)",
      labels: labelsOf(record["labels"]),
      title: textOf2(record["title"], 1000),
      body: textOf2(record["body"], 200000)
    };
  };
  var getJson = async (url) => {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok)
      throw new Error(`HTTP ${String(response.status)}（${url}）`);
    return { value: await response.json(), response };
  };
  var fetchIssue = async (apiBase, repo, issueNumber) => {
    const base = `${apiBase}/repos/${repo}/issues/${String(issueNumber)}`;
    const first = await getJson(base);
    const ratelimit = first.response.headers.get("x-ratelimit-remaining");
    const commentsResult = await getJson(`${base}/comments?per_page=100`);
    return {
      issue: parseIssue(first.value, issueNumber),
      comments: parseComments(commentsResult.value),
      ...ratelimit === null ? {} : { ratelimit: ratelimit.slice(0, 20) }
    };
  };

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

  // src/shared/room-load.ts
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
  var mismatchedOf = (loaded) => loaded.filter((item) => item.status !== 200 || item.hash !== item.entry.sha256);

  // src/outer/preview-room.ts
  var loadPreviewRoom = async (room) => {
    const fetched = await fetchResource(urlInRoom(room.baseUrl, "manifest.json"));
    if (!fetched.ok)
      throw new Error(`manifest.json を読めません（HTTP ${String(fetched.status)}）`);
    let parsed;
    try {
      parsed = JSON.parse(decodeText(fetched.buffer));
    } catch {
      throw new Error("manifest.json を JSON として読めません");
    }
    const manifest = parseManifest(parsed);
    if (manifest === undefined)
      throw new Error("manifest.json の形が不正です");
    const loaded = await loadEntries(room.baseUrl, manifest.modules, 6);
    const mismatched = mismatchedOf(loaded);
    if (mismatched.length > 0) {
      const names = mismatched.map((item) => item.entry.name).join(", ");
      throw new Error(`部屋のモジュールのハッシュが一致しません: ${names}`);
    }
    return { manifest, modules: sourcesOf(loaded) };
  };

  // src/outer/preview-ui.ts
  var requireElement = (id) => {
    const element = document.getElementById(id);
    if (element === null)
      throw new Error(`画面の部品が無い: ${id}`);
    return element;
  };
  var toneOf = (verdict) => verdict === "ready" ? "ok" : "bad";
  var createPreviewUi = () => {
    const status = requireElement("status");
    const problems = requireElement("problems");
    const issueLine = requireElement("issue-line");
    const nameLine = requireElement("name-line");
    const charsLine = requireElement("chars-line");
    const sha = requireElement("sha");
    const labelsLine = requireElement("labels-line");
    const verdictLine = requireElement("verdict-line");
    const ratelimitLine = requireElement("ratelimit-line");
    const describeLine = requireElement("describe-line");
    const describe = requireElement("describe");
    const framesLine = requireElement("frames-line");
    const previewError = requireElement("preview-error");
    const again = requireElement("again");
    const stop = requireElement("stop");
    const setStatus = (text, tone = "idle") => {
      status.textContent = text;
      status.dataset["tone"] = tone;
    };
    const showProblems = (lines) => {
      problems.replaceChildren();
      for (const line of lines) {
        const paragraph = document.createElement("p");
        paragraph.textContent = line;
        problems.append(paragraph);
      }
    };
    const resetPreview = () => {
      describeLine.textContent = "describe";
      describe.textContent = "—";
      framesLine.textContent = "—";
      previewError.textContent = "";
    };
    const setRunning = (running) => {
      again.disabled = running;
      stop.disabled = !running;
    };
    setRunning(false);
    return {
      setStatus,
      showProblems,
      setIssue: (number, state, author) => {
        issueLine.textContent = `#${String(number)} ${state} 作者=${author}`;
      },
      setName: (name) => {
        nameLine.textContent = name === undefined ? "名前: （なし）" : `名前: ${name}`;
      },
      setChars: (chars) => {
        charsLine.textContent = chars === undefined ? "コード: （なし）" : `コード: ${String(chars)} 文字`;
      },
      setSha: (value) => {
        sha.value = value ?? "";
      },
      setLabels: (labels) => {
        const ok = labels.includes("check:ok");
        const ng = labels.includes("check:ng");
        labelsLine.textContent = `ラベル: ${labels.length === 0 ? "（なし）" : labels.join(", ")}` + `（check:ok=${ok ? "あり" : "なし"} check:ng=${ng ? "あり" : "なし"}）`;
      },
      setVerdict: (verdict, reasons) => {
        verdictLine.textContent = `判定: ${verdict}（${verdictLabel(verdict)}）${reasons.join(" / ")}`;
        verdictLine.dataset["tone"] = toneOf(verdict);
      },
      setRatelimit: (value) => {
        ratelimitLine.textContent = value === undefined ? "認証なしの API の残り: （読めません）" : `認証なしの API の残り: ${value}`;
      },
      resetPreview,
      setDescribe: (title, text) => {
        describeLine.textContent = title;
        describe.textContent = text;
      },
      setFrames: (text) => {
        framesLine.textContent = text;
      },
      setPreviewError: (text) => {
        previewError.textContent = text;
      },
      setRunning,
      onAgain: (handler) => {
        again.addEventListener("click", handler);
      },
      onStop: (handler) => {
        stop.addEventListener("click", handler);
      }
    };
  };

  // src/outer/preview.ts
  var state = { finished: false, verdict: "running" };
  var publish = () => {
    Reflect.set(window, "__preview", { ...state });
  };
  var cut = (text, limit) => text.length > limit ? `${text.slice(0, limit)}…` : text;
  var errorText = (error) => cut(describeError(error), 300);
  var finish = (verdict, extra = {}) => {
    Object.assign(state, extra, { verdict, finished: true });
    publish();
  };
  var main = async () => {
    const ui = createPreviewUi();
    publish();
    ui.setStatus("準備中");
    const parsed = parsePreviewArgs(new URLSearchParams(location.search));
    if (parsed.kind === "bad") {
      ui.setStatus("指定を確かめてください", "bad");
      ui.showProblems([...PREVIEW_USAGE_LINES, ...parsed.problems]);
      finish("usage", { problems: parsed.problems });
      return;
    }
    const { room, repo, issue, apiBase } = parsed.args;
    let roomData;
    try {
      ui.setStatus("部屋を読んでいます");
      roomData = await loadPreviewRoom(room);
    } catch (error) {
      const detail = `部屋を読めません: ${errorText(error)}`;
      ui.setStatus("部屋を読めません", "bad");
      ui.showProblems([detail]);
      finish("error", { error: detail });
      return;
    }
    let fetched;
    try {
      ui.setStatus("イシューを読んでいます");
      fetched = await fetchIssue(apiBase, repo, issue);
    } catch (error) {
      const detail = `イシューを読めません: ${errorText(error)}`;
      ui.setStatus("イシューを読めません", "bad");
      ui.showProblems([detail]);
      finish("error", { error: detail });
      return;
    }
    const issueData = fetched.issue;
    const shape = inspectContribution(issueData.title, issueData.body);
    const sha256 = shape.kind === "ok" ? await sha256Hex(new TextEncoder().encode(shape.code)) : "";
    const judged = judgeContribution({
      shapeOk: shape.kind === "ok",
      state: issueData.state,
      labels: issueData.labels,
      marker: readMarker(fetched.comments),
      sha256
    });
    ui.setIssue(issueData.number, issueData.state, issueData.author);
    ui.setName(shape.kind === "ok" ? shape.name : undefined);
    ui.setChars(shape.kind === "ok" ? shape.code.length : undefined);
    ui.setSha(sha256 === "" ? undefined : sha256);
    ui.setLabels(issueData.labels);
    ui.setVerdict(judged.verdict, judged.reasons);
    ui.setRatelimit(fetched.ratelimit);
    Object.assign(state, {
      name: shape.kind === "ok" ? shape.name : null,
      sha256: sha256 === "" ? null : sha256,
      issue: issueData.number,
      issueState: issueData.state,
      author: issueData.author,
      labels: [...issueData.labels],
      ratelimit: fetched.ratelimit ?? null,
      reasons: [...judged.reasons]
    });
    if (shape.kind !== "ok") {
      ui.setStatus("下見は実行しません（形が整っていない）", "bad");
      ui.setFrames("下見は実行していません");
      ui.setPreviewError(shape.reason);
      finish("shape-error", {
        shapeError: shape.reason,
        describe: null,
        frames: null,
        error: shape.reason,
        stopped: false
      });
      return;
    }
    const modules = [
      ...roomData.modules.filter((module) => module.name !== shape.name),
      { name: shape.name, source: shape.code }
    ];
    let frame;
    try {
      frame = await connectFrame();
    } catch (error) {
      const detail = `枠につながりません: ${errorText(error)}`;
      ui.setStatus("枠につながりません", "bad");
      ui.showProblems([detail]);
      finish(judged.verdict, { error: detail, describe: null, frames: null, stopped: false });
      return;
    }
    let running = false;
    const applyPreview = (result) => {
      const view = viewOfPreviewResult(result);
      ui.setDescribe(view.describeTitle, view.describeBody);
      ui.setFrames(view.framesText);
      ui.setPreviewError(view.errorLine ?? "");
      ui.setStatus(view.statusText, view.tone);
      Object.assign(state, {
        describe: view.describe,
        frames: view.frames,
        stopped: view.stopped,
        error: view.errorLine,
        drawPresent: result["drawPresent"] === true,
        nothing: result["nothing"] === true
      });
    };
    const runPreview = async () => {
      if (running)
        return;
      running = true;
      ui.setRunning(true);
      ui.resetPreview();
      ui.setStatus("下見を実行中…");
      Object.assign(state, { finished: false, describe: null, frames: null, error: null, stopped: false });
      publish();
      try {
        const raw = await frame.call("preview-run", { modules, name: shape.name }, 30000);
        const result = asRecord(raw);
        if (result === undefined)
          throw new Error("枠から下見の結果が来ませんでした");
        applyPreview(result);
      } catch (error) {
        const detail = errorText(error);
        ui.setStatus("下見に失敗しました", "bad");
        ui.setPreviewError(detail);
        Object.assign(state, { error: detail });
      } finally {
        running = false;
        ui.setRunning(false);
        state["finished"] = true;
        publish();
      }
    };
    ui.onAgain(() => {
      runPreview();
    });
    ui.onStop(() => {
      (async () => {
        try {
          await frame.call("preview-stop", {}, 5000);
        } catch (error) {
          ui.setPreviewError(errorText(error));
        }
      })();
    });
    const tone = judged.verdict === "ready" ? "ok" : "idle";
    ui.setStatus(`判定 ${judged.verdict}: ${verdictLabel(judged.verdict)}`, tone);
    state["verdict"] = judged.verdict;
    publish();
    await runPreview();
  };
  var refuseEmbedded = () => {
    document.body.textContent = "ほかのサイトに埋め込まれているので動きません";
    Reflect.set(window, "__preview", { finished: true, verdict: "refused", refused: "embedded" });
  };
  if (window.top !== window.self) {
    refuseEmbedded();
  } else {
    main().catch((error) => {
      document.body.textContent = `起動に失敗: ${describeError(error)}`;
      Reflect.set(window, "__preview", { finished: true, verdict: "error", error: describeError(error) });
    });
  }
})();
