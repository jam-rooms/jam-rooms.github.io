"use strict";
(() => {

  var ok = (value) => ({ ok: true, value });
  var fail = (code, detail) => detail === undefined ? { ok: false, code } : { ok: false, code, detail };
  var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  var hasOnlyKeys = (value, allowed) => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key))
        return false;
    }
    return true;
  };

  var NAME_PATTERN = /^(?!(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$)[a-z][a-z0-9-]{0,39}$/;
  var SHA256_PATTERN = /^[0-9a-f]{64}$/;
  var FLOORS = {
    codeChars: 48000,
    checkMs: 2000,
    describeBytes: 262144,
    canvasSize: 4096
  };
  var DEFAULTS = {
    codeChars: 24000,
    checkMs: 1000,
    describeBytes: 65536,
    canvasWidth: 960,
    canvasHeight: 540
  };
  var FIXED = {
    bodyChars: 65536,
    manualChars: 48000,
    depsMax: 16,
    libCountMax: 16,
    libBytesMax: 4194304,
    libTotalBytesMax: 16777216,
    bundleBytesMax: 16777216,
    modulesMax: 2000,
    wasmMemoryBytes: 67108864,
    childExtraBytes: 134217728,
    messagesPerSecond: 1000,
    textCharsPerCall: 2000,
    textTotalBytes: 65536,
    titleChars: 200,
    licenseChars: 100,
    watchIntervalMs: 25,
    childGraceMs: 500,
    parentGraceMs: 2000,
    watchLoadMs: 1e4,
    watchSilenceMs: 2000,
    pingMs: 250,
    fetchTimeoutMs: 30000,
    apiBytesMax: 8388608,
    frameGapMs: 1000,
    frameTickMs: 100,
    frameTickSlackMs: 500,
    errorsMax: 20,
    errorChars: 300,
    frameReadyMs: 1e4,
    textLinesMax: 200,
    keyChars: 32
  };
  var LIMIT_KEYS = [
    "codeChars",
    "checkMs",
    "describeBytes",
    "canvasWidth",
    "canvasHeight"
  ];
  var LIMIT_RANGES = {
    codeChars: { min: 1, max: FLOORS.codeChars },
    checkMs: { min: 1, max: FLOORS.checkMs },
    describeBytes: { min: 1, max: FLOORS.describeBytes },
    canvasWidth: { min: 16, max: FLOORS.canvasSize },
    canvasHeight: { min: 16, max: FLOORS.canvasSize }
  };
  var isLimitKey = (key) => LIMIT_KEYS.includes(key);
  var resolveLimits = (overrides) => {
    if (overrides === undefined)
      return ok({ ...DEFAULTS });
    if (!isRecord(overrides))
      return fail("bad-limits");
    try {
      for (const key of Object.keys(overrides)) {
        if (!isLimitKey(key))
          return fail("bad-limits");
      }
      const resolved = { ...DEFAULTS };
      for (const key of LIMIT_KEYS) {
        if (!Object.hasOwn(overrides, key))
          continue;
        const value = overrides[key];
        const range = LIMIT_RANGES[key];
        if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) {
          return fail("bad-limits", key);
        }
        resolved[key] = value;
      }
      return ok({ ...resolved });
    } catch {
      return fail("bad-limits");
    }
  };
  var encoder = new TextEncoder;
  var HEX = "0123456789abcdef";
  var toHex = (bytes) => {
    let hex = "";
    for (const byte of bytes) {
      hex += HEX[byte >> 4] ?? "0";
      hex += HEX[byte & 15] ?? "0";
    }
    return hex;
  };
  var utf8Bytes = (text) => encoder.encode(text).length;
  var sha256Hex = async (data) => {
    const bytes = typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return toHex(new Uint8Array(digest));
  };
  var submissionDigest = (name, code) => sha256Hex(`${name}
${code}`);
  var WORD_PATTERN = /(?<![A-Za-z0-9_])(?:import|export|from)(?![A-Za-z0-9_])/g;
  var SPACE_PATTERN = /\s/y;
  var NAME_CHAR_PATTERN = /[A-Za-z0-9_$\\\u0080-\uFFFF]/y;
  var SPECIFIER_PATTERN = /(["'])((?:room|lib):[a-z][a-z0-9-]{0,39})\1/y;
  var SEQUENCE_PATTERN = /[\sA-Za-z0-9_$,{}*\u0080-\uFFFF]*/y;
  var FAIL = { kind: "fail" };
  var pass = (span = null, skipUntil = 0) => ({ kind: "pass", span, skipUntil });
  var isSpaceAt = (text, index) => {
    SPACE_PATTERN.lastIndex = index;
    return SPACE_PATTERN.test(text);
  };
  var skipSpaces = (code, from) => {
    let index = from;
    while (index < code.length && isSpaceAt(code, index))
      index += 1;
    return index;
  };
  var isQuoteAt = (code, index) => {
    const ch = code.charAt(index);
    return ch === '"' || ch === "'";
  };
  var isCommentAt = (code, index) => code.startsWith("//", index) || code.startsWith("/*", index);
  var isNameCharAt = (code, index) => {
    if (index >= code.length)
      return false;
    NAME_CHAR_PATTERN.lastIndex = index;
    return NAME_CHAR_PATTERN.test(code);
  };
  var specifierAt = (code, index) => {
    SPECIFIER_PATTERN.lastIndex = index;
    const match = SPECIFIER_PATTERN.exec(code);
    if (match === null)
      return null;
    const specifier = match[2];
    if (specifier === undefined)
      return null;
    return { start: index + 1, end: index + specifier.length + 1, specifier };
  };
  var isWordChar = (ch) => {
    const code = ch.charCodeAt(0);
    return code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 95;
  };
  var trimSpacesEnd = (text) => {
    let end = text.length;
    while (end > 0 && isSpaceAt(text, end - 1))
      end -= 1;
    return text.slice(0, end);
  };
  var endsWithWordFrom = (text) => text.length >= 4 && text.endsWith("from") && (text.length === 4 || !isWordChar(text.charAt(text.length - 5)));
  var checkSequence = (code, from) => {
    SEQUENCE_PATTERN.lastIndex = from;
    const match = SEQUENCE_PATTERN.exec(code);
    if (match === null)
      return FAIL;
    const sequence = match[0];
    const end = from + sequence.length;
    if (!isQuoteAt(code, end))
      return FAIL;
    if (!endsWithWordFrom(trimSpacesEnd(sequence)))
      return FAIL;
    return pass(null, end);
  };
  var checkImport = (code, index) => {
    const afterWord = index + 6;
    const afterMeta = afterWord + 5;
    if (code.startsWith(".meta", afterWord) && !isNameCharAt(code, afterMeta)) {
      return pass();
    }
    const afterSpaces = skipSpaces(code, afterWord);
    if (isQuoteAt(code, afterSpaces)) {
      const span = specifierAt(code, afterSpaces);
      return span === null ? FAIL : pass(span, afterWord);
    }
    return checkSequence(code, afterWord);
  };
  var checkExport = (code, index) => {
    const afterWord = index + 6;
    const afterSpaces = skipSpaces(code, afterWord);
    if (isCommentAt(code, afterSpaces))
      return FAIL;
    if (code.charAt(afterSpaces) === "*")
      return checkSequence(code, afterWord);
    return pass();
  };
  var checkFrom = (code, index) => {
    const afterWord = index + 4;
    const before = code.charAt(index - 1);
    if (isQuoteAt(code, index - 1) && code.charAt(afterWord) === before)
      return pass();
    const afterSpaces = skipSpaces(code, afterWord);
    if (isCommentAt(code, afterSpaces))
      return FAIL;
    if (isQuoteAt(code, afterSpaces)) {
      const span = specifierAt(code, afterSpaces);
      return span === null ? FAIL : pass(span, afterWord);
    }
    return pass();
  };
  var checkWord = (code, word, index) => {
    if (word === "import")
      return checkImport(code, index);
    if (word === "export")
      return checkExport(code, index);
    return checkFrom(code, index);
  };
  var lineAt = (code, index) => {
    let line = 1;
    for (let i = 0;i < index; i += 1) {
      if (code.charCodeAt(i) === 10)
        line += 1;
    }
    return line;
  };
  var findSpecifiers = (code) => {
    const spans = [];
    let skipUntil = 0;
    let spanEnd = 0;
    WORD_PATTERN.lastIndex = 0;
    for (let match = WORD_PATTERN.exec(code);match !== null; match = WORD_PATTERN.exec(code)) {
      const word = match[0];
      const index = match.index;
      if (index < spanEnd)
        continue;
      if (word !== "from" && index < skipUntil)
        continue;
      const outcome = checkWord(code, word, index);
      if (outcome.kind === "fail") {
        return fail("bad-import", `line:${lineAt(code, index)}`);
      }
      if (outcome.span !== null) {
        spans.push(outcome.span);
        spanEnd = outcome.span.end;
      }
      if (outcome.skipUntil > skipUntil)
        skipUntil = outcome.skipUntil;
    }
    return ok(spans);
  };
  var findImports = (code) => {
    const found = findSpecifiers(code);
    if (!found.ok)
      return found;
    const room = [];
    const lib = [];
    const seen = new Set;
    for (const span of found.value) {
      if (seen.has(span.specifier))
        continue;
      seen.add(span.specifier);
      const colon = span.specifier.indexOf(":");
      const kind = span.specifier.slice(0, colon);
      const name = span.specifier.slice(colon + 1);
      if (kind === "room")
        room.push(name);
      else
        lib.push(name);
    }
    return ok({ room, lib });
  };
  var TITLE_PREFIX = "contribute: ";
  var START_PATTERN = /^```js[ \t]*$/;
  var END_PATTERN = /^ {0,3}```[ \t]*$/;
  var TAG_PATTERN = /<[A-Za-z/!?]/;
  var BACKTICKS_ONLY_PATTERN = /^`{3,}$/;
  var FORBIDDEN_PATTERN = /(?![\n\t])[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\p{Noncharacter_Code_Point}]/u;
  var failure = (code) => ({ code: null, error: code });
  var scanLines = (lines) => {
    const codeLines = [];
    let inBlock = false;
    let started = false;
    let closed = false;
    let code = null;
    for (const line of lines) {
      if (!inBlock) {
        if (START_PATTERN.test(line)) {
          if (started)
            return failure("many-code");
          started = true;
          inBlock = true;
          continue;
        }
        if (line.includes("```") || line.includes("~~~"))
          return failure("bad-body");
        if (TAG_PATTERN.test(line))
          return failure("bad-body");
        continue;
      }
      if (END_PATTERN.test(line)) {
        inBlock = false;
        closed = true;
        code = codeLines.join(`
`);
        continue;
      }
      if (BACKTICKS_ONLY_PATTERN.test(line.trim()))
        return failure("bad-body");
      codeLines.push(line);
    }
    if (!started || !closed)
      return failure("no-code");
    return { code, error: null };
  };
  var invalid = (code, name) => ({ kind: "invalid", code, name });
  var parseSubmission = (input, options) => {
    const title = input.title;
    if (!title.startsWith(TITLE_PREFIX))
      return { kind: "skip" };
    const name = title.slice(TITLE_PREFIX.length);
    if (!NAME_PATTERN.test(name))
      return invalid("bad-name", null);
    if (name === options.entryName)
      return invalid("bad-name", name);
    const body = input.body;
    if (body.length > FIXED.bodyChars)
      return invalid("too-large", name);
    if (!body.isWellFormed())
      return invalid("bad-body", name);
    const text = body.replaceAll(`\r
`, `
`);
    if (text.includes("\r"))
      return invalid("bad-body", name);
    if (FORBIDDEN_PATTERN.test(text))
      return invalid("bad-body", name);
    const scanned = scanLines(text.split(`
`));
    if (scanned.error !== null)
      return invalid(scanned.error, name);
    const code = scanned.code ?? "";
    if (code.trim() === "")
      return invalid("no-code", name);
    if (code.length > options.codeCharsMax)
      return invalid("too-large", name);
    const found = findImports(code);
    if (!found.ok)
      return invalid("bad-import", name);
    const { room: roomDeps, lib: libDeps } = found.value;
    if (roomDeps.includes(name))
      return invalid("bad-import", name);
    if (roomDeps.length + libDeps.length > FIXED.depsMax)
      return invalid("too-many-deps", name);
    return { kind: "ok", submission: { name, code, roomDeps, libDeps } };
  };
  var CHECK_CODES = [
    "ok",
    "ok-static",
    "bad-name",
    "no-code",
    "many-code",
    "bad-body",
    "too-large",
    "bad-import",
    "missing-dep",
    "too-many-deps",
    "load-error",
    "timeout",
    "memory",
    "bad-describe",
    "internal"
  ];
  var isCheckCode = (value) => typeof value === "string" && CHECK_CODES.includes(value);
  var isPassing = (code) => code === "ok" || code === "ok-static";
  var MARKER_PATTERN = /^<!-- jamroom-check v1 code=(?<code>[a-z][a-z0-9-]*) sha256=(?<digest>[0-9a-f]{64}|-) name=(?<name>[a-z][a-z0-9-]{0,39}|-) -->$/;
  var SHA256_ABSENT = "-";
  var NAME_ABSENT = "-";
  var parseLine = (line) => {
    const groups = MARKER_PATTERN.exec(line)?.groups;
    if (groups === undefined)
      return null;
    const code = groups["code"];
    const digest = groups["digest"];
    const name = groups["name"];
    if (code === undefined || digest === undefined || name === undefined)
      return null;
    if (!isCheckCode(code))
      return null;
    return {
      code,
      digest: digest === SHA256_ABSENT ? null : digest,
      name: name === NAME_ABSENT ? null : name
    };
  };
  var parseMarker = (commentBody) => {
    let found = null;
    for (const rawLine of commentBody.split(/\r\n|\r|\n/)) {
      const marker = parseLine(rawLine.trim());
      if (marker === null)
        continue;
      if (found !== null)
        return null;
      found = marker;
    }
    return found;
  };
  var BOT_LOGIN = "github-actions[bot]";
  var pickBotMarker = (comments) => {
    for (let index = comments.length - 1;index >= 0; index -= 1) {
      const comment = comments[index];
      if (comment === undefined)
        continue;
      if (comment.user === null)
        continue;
      if (comment.user.login !== BOT_LOGIN || comment.user.type !== "Bot")
        continue;
      if (comment.editedByOther === true)
        continue;
      if (comment.body === null)
        continue;
      const marker = parseMarker(comment.body);
      if (marker !== null)
        return marker;
    }
    return null;
  };
  var decideVerdict = (input) => {
    if (input.state === "closed")
      return "closed";
    if (input.parsed.kind !== "ok" || input.digest === null)
      return "shape-error";
    const marker = input.marker;
    if (marker === null)
      return "not-checked";
    if (marker.digest !== input.digest)
      return "stale";
    if (!isPassing(marker.code))
      return "failed";
    if (!input.hasOkLabel)
      return "failed";
    return "ready";
  };
  var CONFIG_KEYS = ["format", "title", "entry", "surface", "lib", "license", "limits"];
  var LIB_KEYS = ["name", "path", "sha256", "bytes"];
  var SURFACE_VALUES = ["2d", "webgl2"];
  var LIB_PATH_PATTERN = /^lib\/[A-Za-z0-9._-]{1,80}\.js$/;
  var isText = (value, maxChars) => typeof value === "string" && value.length >= 1 && value.length <= maxChars && value.isWellFormed();
  var isSurface = (value) => typeof value === "string" && SURFACE_VALUES.includes(value);
  var parseLibEntry = (value) => {
    if (!isRecord(value) || !hasOnlyKeys(value, LIB_KEYS))
      return fail("bad-config", "lib");
    const name = value["name"];
    if (typeof name !== "string" || !NAME_PATTERN.test(name))
      return fail("bad-config", "lib.name");
    const path = value["path"];
    if (typeof path !== "string" || !LIB_PATH_PATTERN.test(path) || path.includes("..")) {
      return fail("bad-config", "lib.path");
    }
    const sha256 = value["sha256"];
    if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256))
      return fail("bad-config", "lib.sha256");
    const bytes = value["bytes"];
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 1 || bytes > FIXED.libBytesMax) {
      return fail("bad-config", "lib.bytes");
    }
    return ok({ name, path, sha256, bytes });
  };
  var parseLib = (value) => {
    if (!Array.isArray(value))
      return fail("bad-config", "lib");
    if (value.length > FIXED.libCountMax)
      return fail("bad-config", "lib");
    const entries = [];
    const names = new Set;
    let totalBytes = 0;
    for (const item of value) {
      const parsed = parseLibEntry(item);
      if (!parsed.ok)
        return parsed;
      if (names.has(parsed.value.name))
        return fail("bad-config", "lib.name");
      names.add(parsed.value.name);
      totalBytes += parsed.value.bytes;
      if (totalBytes > FIXED.libTotalBytesMax)
        return fail("bad-config", "lib.bytes");
      entries.push(parsed.value);
    }
    return ok(entries);
  };
  var parseRoomConfig = (json) => {
    if (!isRecord(json))
      return fail("bad-config");
    if (!hasOnlyKeys(json, CONFIG_KEYS))
      return fail("bad-config");
    if (json["format"] !== 1)
      return fail("bad-config", "format");
    const title = json["title"];
    if (!isText(title, FIXED.titleChars))
      return fail("bad-config", "title");
    const entry = json["entry"];
    if (typeof entry !== "string" || !NAME_PATTERN.test(entry))
      return fail("bad-config", "entry");
    const surface = json["surface"];
    if (!isSurface(surface))
      return fail("bad-config", "surface");
    const license = json["license"];
    if (!isText(license, FIXED.licenseChars))
      return fail("bad-config", "license");
    let lib = [];
    if (Object.hasOwn(json, "lib")) {
      const parsed = parseLib(json["lib"]);
      if (!parsed.ok)
        return parsed;
      lib = parsed.value;
    }
    const resolved = resolveLimits(Object.hasOwn(json, "limits") ? json["limits"] : undefined);
    if (!resolved.ok)
      return fail("bad-config", "limits");
    return ok({ format: 1, title, entry, surface, lib, license, limits: resolved.value });
  };
  var MANIFEST_KEYS = ["format", "modules"];
  var MODULE_KEYS = ["name", "path", "sha256", "bytes", "issue", "author", "adoptedAt"];
  var AUTHOR_KEYS = ["login", "id"];
  var LOGIN_PATTERN = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;
  var ADOPTED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
  var modulePath = (name) => `modules/${name}.js`;
  var parseAuthor = (value, index) => {
    if (!isRecord(value) || !hasOnlyKeys(value, AUTHOR_KEYS)) {
      return fail("bad-manifest", `modules[${index}].author`);
    }
    const login = value["login"];
    if (typeof login !== "string" || !LOGIN_PATTERN.test(login)) {
      return fail("bad-manifest", `modules[${index}].author.login`);
    }
    const id = value["id"];
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      return fail("bad-manifest", `modules[${index}].author.id`);
    }
    return ok({ login, id });
  };
  var parseModuleEntry = (value, index) => {
    if (!isRecord(value) || !hasOnlyKeys(value, MODULE_KEYS)) {
      return fail("bad-manifest", `modules[${index}]`);
    }
    const name = value["name"];
    if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
      return fail("bad-manifest", `modules[${index}].name`);
    }
    const path = value["path"];
    if (path !== modulePath(name))
      return fail("bad-manifest", `modules[${index}].path`);
    const sha256 = value["sha256"];
    if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
      return fail("bad-manifest", `modules[${index}].sha256`);
    }
    const bytes = value["bytes"];
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
      return fail("bad-manifest", `modules[${index}].bytes`);
    }
    const issue = value["issue"];
    if (issue !== null && (typeof issue !== "number" || !Number.isSafeInteger(issue) || issue < 1)) {
      return fail("bad-manifest", `modules[${index}].issue`);
    }
    const author = parseAuthor(value["author"], index);
    if (!author.ok)
      return author;
    const adoptedAt = value["adoptedAt"];
    if (typeof adoptedAt !== "string" || !ADOPTED_AT_PATTERN.test(adoptedAt) || Number.isNaN(Date.parse(adoptedAt))) {
      return fail("bad-manifest", `modules[${index}].adoptedAt`);
    }
    return ok({ name, path: modulePath(name), sha256, bytes, issue, author: author.value, adoptedAt });
  };
  var parseManifest = (json) => {
    try {
      if (!isRecord(json) || !hasOnlyKeys(json, MANIFEST_KEYS))
        return fail("bad-manifest");
      if (json["format"] !== 1)
        return fail("bad-manifest", "format");
      const rawModules = json["modules"];
      if (!Array.isArray(rawModules))
        return fail("bad-manifest", "modules");
      if (rawModules.length > FIXED.modulesMax)
        return fail("bad-manifest", "modules");
      const modules = [];
      const names = new Set;
      for (let index = 0;index < rawModules.length; index += 1) {
        const parsed = parseModuleEntry(rawModules[index], index);
        if (!parsed.ok)
          return parsed;
        const name = parsed.value.name;
        if (names.has(name))
          return fail("bad-manifest", `modules[${index}].name`);
        names.add(name);
        modules.push(parsed.value);
      }
      return ok({ format: 1, modules });
    } catch {
      return fail("bad-manifest");
    }
  };
  var serializeManifest = (manifest) => `${JSON.stringify(manifest, null, 2)}
`;
  var makeEntry = async (input) => ({
    name: input.name,
    path: modulePath(input.name),
    sha256: await sha256Hex(input.code),
    bytes: utf8Bytes(input.code),
    issue: input.issue,
    author: { login: input.author.login, id: input.author.id },
    adoptedAt: input.adoptedAt
  });
  var upsertModule = (manifest, entry, options) => {
    const index = manifest.modules.findIndex((module) => module.name === entry.name);
    if (index >= 0 && !options.replace)
      return fail("name-taken");
    if (index < 0 && options.replace)
      return fail("not-found");
    const modules = [...manifest.modules];
    if (index >= 0)
      modules[index] = entry;
    else
      modules.push(entry);
    return ok({ format: manifest.format, modules });
  };
  var heapPush = (heap, node) => {
    let position = heap.length;
    heap.push(node);
    while (position > 0) {
      const parentPosition = position - 1 >> 1;
      const parent = heap[parentPosition];
      if (parent === undefined || parent.index <= node.index)
        break;
      heap[position] = parent;
      position = parentPosition;
    }
    heap[position] = node;
  };
  var heapPop = (heap) => {
    const first = heap[0];
    const last = heap.pop();
    if (first === undefined || last === undefined)
      return;
    if (heap.length === 0)
      return first;
    const length = heap.length;
    let position = 0;
    for (;; ) {
      const leftPosition = position * 2 + 1;
      if (leftPosition >= length)
        break;
      const rightPosition = leftPosition + 1;
      let childPosition = leftPosition;
      const left = heap[leftPosition];
      const right = heap[rightPosition];
      if (left !== undefined && right !== undefined && right.index < left.index)
        childPosition = rightPosition;
      const child = heap[childPosition];
      if (child === undefined || child.index >= last.index)
        break;
      heap[position] = child;
      position = childPosition;
    }
    heap[position] = last;
    return first;
  };
  var prepare = (name, index, code, target, libNames) => {
    const found = findImports(code);
    if (!found.ok)
      return { name, index, deps: [], bad: true, remaining: 0, dependents: [] };
    const deps = [];
    let bad = false;
    for (const dep of found.value.room) {
      const position = target.get(dep);
      if (position === undefined)
        bad = true;
      else
        deps.push(position);
    }
    for (const lib of found.value.lib) {
      if (!libNames.has(lib))
        bad = true;
    }
    return { name, index, deps, bad, remaining: deps.length, dependents: [] };
  };
  var planLoad = (sources, libNames) => {
    const names = [...sources.keys()];
    const target = new Map;
    for (const [index, name] of names.entries())
      target.set(name, index);
    const nodes = [];
    for (const [index, name] of names.entries()) {
      nodes.push(prepare(name, index, sources.get(name) ?? "", target, libNames));
    }
    for (const node of nodes) {
      for (const dep of node.deps)
        nodes[dep]?.dependents.push(node.index);
    }
    const heap = [];
    for (const node of nodes) {
      if (!node.bad && node.remaining === 0)
        heapPush(heap, node);
    }
    const order = [];
    const emitted = new Set;
    for (;; ) {
      const node = heapPop(heap);
      if (node === undefined)
        break;
      if (emitted.has(node.index))
        continue;
      emitted.add(node.index);
      order.push(node.name);
      for (const dependent of node.dependents) {
        const next = nodes[dependent];
        if (next === undefined)
          continue;
        next.remaining -= 1;
        if (next.remaining === 0 && !next.bad)
          heapPush(heap, next);
      }
    }
    const floating = nodes.filter((node) => !emitted.has(node.index)).map((node) => node.name);
    return { order, floating };
  };
  var withCandidate = (sources, candidate) => {
    const merged = new Map;
    let replaces = false;
    for (const [name, code] of sources) {
      if (name === candidate.name) {
        merged.set(name, candidate.code);
        replaces = true;
      } else {
        merged.set(name, code);
      }
    }
    if (!replaces)
      merged.set(candidate.name, candidate.code);
    return { merged, replaces };
  };
  var findMissing = (candidate, merged, libNames) => {
    const found = findImports(candidate.code);
    if (!found.ok)
      return [];
    const missing = [];
    for (const name of found.value.room) {
      if (!merged.has(name))
        missing.push(`room:${name}`);
    }
    for (const lib of found.value.lib) {
      if (!libNames.has(lib))
        missing.push(`lib:${lib}`);
    }
    return missing;
  };
  var reachableFrom = (candidateName, merged) => {
    const visited = new Set([candidateName]);
    const queue = [candidateName];
    let usesLib = false;
    for (let cursor = 0;cursor < queue.length; cursor += 1) {
      const name = queue[cursor];
      if (name === undefined)
        continue;
      const code = merged.get(name);
      if (code === undefined)
        continue;
      const found = findImports(code);
      if (!found.ok)
        continue;
      if (found.value.lib.length > 0)
        usesLib = true;
      for (const dep of found.value.room) {
        if (visited.has(dep) || !merged.has(dep))
          continue;
        visited.add(dep);
        queue.push(dep);
      }
    }
    return { visited, usesLib };
  };
  var planCandidate = (sources, libNames, candidate) => {
    const { merged, replaces } = withCandidate(sources, candidate);
    const before = planLoad(sources, libNames);
    const plan = planLoad(merged, libNames);
    const floats = plan.floating.includes(candidate.name);
    const floatingBefore = new Set(before.floating);
    const newlyFloating = plan.floating.filter((name) => name !== candidate.name && !floatingBefore.has(name));
    const missing = findMissing(candidate, merged, libNames);
    let closure = [];
    let usesLib = false;
    if (!floats) {
      const reach = reachableFrom(candidate.name, merged);
      usesLib = reach.usesLib;
      closure = plan.order.filter((name) => reach.visited.has(name));
    }
    return { sources: merged, plan, replaces, missing, floats, newlyFloating, closure, usesLib };
  };
  var BUNDLE_KEYS = ["format", "config", "manifest", "sources"];
  var manifestNames = (manifest) => new Set(manifest.modules.map((module) => module.name));
  var matchesEntry = async (entry, code) => {
    if (!code.isWellFormed())
      return false;
    if (utf8Bytes(code) !== entry.bytes)
      return false;
    return await sha256Hex(code) === entry.sha256;
  };
  var checkBundleShape = (json) => {
    if (!isRecord(json) || !hasOnlyKeys(json, BUNDLE_KEYS))
      return fail("bad-bundle");
    if (json["format"] !== 1)
      return fail("bad-bundle", "format");
    return ok(json);
  };
  var checkSourceTexts = (sources, names) => {
    for (const name of Object.keys(sources)) {
      const code = sources[name];
      if (typeof code !== "string" || !code.isWellFormed()) {
        return fail("bad-bundle", names.has(name) ? name : "sources");
      }
    }
    return ok(null);
  };
  var hasSameNames = (sources, names) => {
    const keys = Object.keys(sources);
    if (keys.length !== names.size)
      return false;
    for (const key of keys) {
      if (!names.has(key))
        return false;
    }
    return true;
  };
  var parseBundle = async (text) => {
    if (typeof text !== "string")
      return fail("bad-bundle");
    if (text.length > FIXED.bundleBytesMax)
      return fail("too-large");
    if (utf8Bytes(text) > FIXED.bundleBytesMax)
      return fail("too-large");
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return fail("bad-bundle");
    }
    const shape = checkBundleShape(json);
    if (!shape.ok)
      return shape;
    const bundle = shape.value;
    const config = parseRoomConfig(bundle["config"]);
    if (!config.ok)
      return fail("bad-config", config.detail);
    const manifest = parseManifest(bundle["manifest"]);
    if (!manifest.ok)
      return fail("bad-manifest", manifest.detail);
    const rawSources = bundle["sources"];
    if (!isRecord(rawSources))
      return fail("bad-bundle", "sources");
    const names = manifestNames(manifest.value);
    const broken = checkSourceTexts(rawSources, names);
    if (!broken.ok)
      return broken;
    if (!hasSameNames(rawSources, names))
      return fail("bad-bundle", "sources");
    const sources = new Map;
    for (const entry of manifest.value.modules) {
      const code = rawSources[entry.name];
      if (typeof code !== "string" || !await matchesEntry(entry, code)) {
        return fail("hash-mismatch", entry.name);
      }
      sources.set(entry.name, code);
    }
    return ok({ config: config.value, manifest: manifest.value, sources });
  };
  var VIEWER_OWNER = "jam-rooms";
  var OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
  var REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
  var PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
  var PAGES_SUFFIX = ".github.io";
  var isDotSegment = (segment) => segment === "." || segment === "..";
  var asText = (value) => typeof value === "string" ? value : "";
  var parseRoomAddress = (text) => {
    const parts = asText(text).split("/");
    if (parts.length !== 3)
      return fail("bad-address");
    const scheme = parts[0];
    const owner = parts[1];
    const repo = parts[2];
    if (scheme !== "gh" || owner === undefined || repo === undefined)
      return fail("bad-address");
    if (!OWNER_PATTERN.test(owner))
      return fail("bad-address");
    if (owner.toLowerCase() === VIEWER_OWNER)
      return fail("bad-address");
    if (!REPO_PATTERN.test(repo))
      return fail("bad-address");
    if (isDotSegment(repo))
      return fail("bad-address");
    if (repo.toLowerCase().endsWith(PAGES_SUFFIX))
      return fail("bad-address");
    return ok({
      owner,
      repo,
      slug: `${owner}/${repo}`,
      baseUrl: `https://${owner.toLowerCase()}.github.io/${repo}/`
    });
  };
  var roomFileUrl = (address, path) => {
    if (typeof path !== "string" || !PATH_PATTERN.test(path)) {
      throw new Error("path が部屋の中のファイルを指していません");
    }
    if (path.split("/").some(isDotSegment)) {
      throw new Error("path が部屋の外を指しています");
    }
    return `${address.baseUrl}${path}`;
  };
  var ISSUE_PATTERN = /^[1-9][0-9]{0,9}$/;
  var bad = () => ({ kind: "bad" });
  var readAddress = (text) => {
    const parsed = parseRoomAddress(text);
    return parsed.ok ? parsed.value : undefined;
  };
  var parseViewerRoute = (hash) => {
    if (typeof hash !== "string")
      return bad();
    if (hash === "" || hash === "#")
      return { kind: "home" };
    if (!hash.startsWith("#"))
      return bad();
    const body = hash.slice(1);
    const parts = body.split("/");
    if (parts.length === 3) {
      const address = readAddress(body);
      return address === undefined ? bad() : { kind: "room", address };
    }
    if (parts.length === 5) {
      const keyword = parts[3];
      const numberText = parts[4];
      if (keyword !== "issue" || numberText === undefined)
        return bad();
      if (!ISSUE_PATTERN.test(numberText))
        return bad();
      const issue = Number(numberText);
      if (!Number.isSafeInteger(issue))
        return bad();
      const address = readAddress(`${parts[0] ?? ""}/${parts[1] ?? ""}/${parts[2] ?? ""}`);
      return address === undefined ? bad() : { kind: "review", address, issue };
    }
    return bad();
  };
  var roomVersion = (manifest) => sha256Hex(serializeManifest(manifest));
  var HIDDEN_CHAR = /[\p{Cc}\p{Cf}\p{Cs}\p{Zs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Noncharacter_Code_Point}]/u;
  var BLANK_LOOKING = new Set(["⠀", "\uD81B\uDFE4", "\uD834\uDD59"]);
  var isVisibleSpace = (char) => char === `
` || char === "\t" || char === " " || char === "　";
  var describeHidden = (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`;
  var revealHidden = (text) => {
    if (typeof text !== "string")
      return [];
    const parts = [];
    let visible = [];
    const flush = () => {
      if (visible.length === 0)
        return;
      parts.push({ text: visible.join(""), hidden: false });
      visible = [];
    };
    for (const char of text) {
      if (HIDDEN_CHAR.test(char) && !isVisibleSpace(char) || BLANK_LOOKING.has(char)) {
        flush();
        parts.push({ text: describeHidden(char), hidden: true });
      } else {
        visible.push(char);
      }
    }
    flush();
    return parts;
  };
  var ELLIPSIS = "…";
  var REMOVED_CHARS = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\uFFF9-\uFFFB]/gu;
  var ALNUM = "0-9A-Za-z\\uFF10-\\uFF19\\uFF21-\\uFF3A\\uFF41-\\uFF5A";
  var CODE_CHAR = "[0-9A-Z\\uFF10-\\uFF19\\uFF21-\\uFF3A]";
  var AUTH_CODE = new RegExp(`(?<![${ALNUM}])${CODE_CHAR}{4}\\s{0,3}[-\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D]\\s{0,3}` + `${CODE_CHAR}{4}(?![${ALNUM}])`, "gu");
  var asText2 = (value) => typeof value === "string" ? value : "";
  var stripControls = (text) => asText2(text).replace(REMOVED_CHARS, (char) => char === `
` || char === "\t" ? char : "");
  var clip = (text, maxChars) => {
    const source = asText2(text);
    if (maxChars === Number.POSITIVE_INFINITY)
      return source;
    const max = typeof maxChars === "number" && Number.isFinite(maxChars) ? Math.max(0, Math.trunc(maxChars)) : 0;
    let kept = "";
    let count = 0;
    for (const char of source) {
      if (count >= max)
        return kept + ELLIPSIS;
      kept += char;
      count += 1;
    }
    return kept;
  };
  var BLOCKED_ROOMS = [];
  var matches = (entry, slug) => {
    const parts = entry.split("/");
    if (parts.length !== 2)
      return false;
    const owner = parts[0] ?? "";
    const repo = parts[1] ?? "";
    if (owner === "" || repo === "")
      return false;
    if (repo === "*")
      return slug.startsWith(`${owner}/`) && !slug.slice(owner.length + 1).includes("/");
    return slug === `${owner}/${repo}`;
  };
  var isBlocked = (address, list = BLOCKED_ROOMS) => {
    const slug = address.slug.toLowerCase();
    for (const entry of list) {
      if (matches(entry.toLowerCase(), slug))
        return true;
    }
    return false;
  };

  var ROOM_TEXT = {
    "not-found": "部屋のファイルが見つかりません",
    "http-error": "部屋のサーバが応答を返しませんでした",
    "too-large": "部屋のファイルが大きすぎます",
    timeout: "部屋の読み取りが時間内に終わりませんでした",
    network: "部屋に届きませんでした",
    "bad-text": "部屋のファイルが文字として読めません",
    "bad-bundle": "部屋のまとめの形が違います",
    "bad-config": "部屋の設定の形が違います",
    "bad-manifest": "部屋の目録の形が違います",
    "hash-mismatch": "コードのハッシュ値が目録と合いません",
    "lib-mismatch": "ライブラリが設定と合いません",
    "entry-missing": "入口のファイルが部屋にありません",
    "entry-floating": "入口が動かない状態です"
  };
  var ISSUE_TEXT = {
    "not-found": "イシューが見つかりません",
    "http-error": "GitHub が応答を返しませんでした",
    "too-large": "イシューが大きすぎます",
    timeout: "イシューの読み取りが時間内に終わりませんでした",
    network: "GitHub に届きませんでした",
    "bad-text": "イシューが文字として読めません",
    "bad-response": "イシューの形が違います",
    "rate-limited": "GitHub の API の回数制限に当たりました"
  };
  var RUN_TEXT = {
    user: "止めました",
    silent: "部屋のコードが応答しなくなりました",
    flood: "メッセージが多すぎます",
    "bad-message": "決めた形でないメッセージが届きました",
    "worker-error": "部屋のコードで問題が起きました",
    "lock-failed": "危ない入口をふさげませんでした",
    "load-error": "入口を読み込めませんでした",
    "no-start": "入口に start がありません",
    "start-error": "start が失敗しました",
    "boot-error": "起動できませんでした",
    "canvas-too-large": "キャンバスが大きすぎるので、止めました",
    "render-stall": "描画が戻らなくなりました",
    "frame-error": "枠を用意できませんでした",
    unexpected: "予想していない問題が起きました"
  };
  var VERDICT_TEXT = {
    ready: "検査に通っていて、いまの本文と一致しています",
    stale: "検査が見た内容と、いまの本文が違います",
    "not-checked": "検査の印がありません",
    failed: "検査に落ちています",
    "shape-error": "形が整っていません",
    closed: "イシューが閉じています"
  };
  var SHAPE_TEXT = {
    skip: "提出の形ではありません",
    "bad-name": "名前に使えない形か、入口の名前です",
    "no-code": "コードブロックがありません",
    "many-code": "コードブロックが2つ以上あります",
    "bad-body": "本文の形が違います",
    "too-large": "コードが大きすぎます",
    "bad-import": "読み込みの書き方が違います",
    "too-many-deps": "読み込み先が多すぎます"
  };
  var ROOM_DETAIL_CODES = new Set([
    "lock-failed",
    "load-error",
    "no-start",
    "start-error"
  ]);
  var roomDetail = (code, detail) => detail !== "" && ROOM_DETAIL_CODES.has(code) ? detail : null;
  var roomCodeText = (code) => ROOM_TEXT[code] ?? "部屋を読めませんでした";
  var issueCodeText = (code) => ISSUE_TEXT[code] ?? "イシューを読めませんでした";
  var runCodeText = (code) => RUN_TEXT[code] ?? "止まりました";
  var verdictText = (verdict) => VERDICT_TEXT[verdict] ?? "判定できませんでした";
  var shapeText = (code) => SHAPE_TEXT[code] ?? "形が整っていません";

  var countChars = (text) => {
    let count = 0;
    for (const _ of text)
      count += 1;
    return count;
  };
  var splitCodeLines = (code) => {
    const source = typeof code === "string" ? code : "";
    const lines = source.split(`
`).map((text, index) => ({
      number: index + 1,
      parts: revealHidden(text)
    }));
    return { lines, lineCount: lines.length, charCount: countChars(source) };
  };

  var requestInit = (signal) => ({
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    cache: "no-cache",
    signal
  });
  var release = (controller, body) => {
    controller.abort();
    body?.cancel().catch(() => {
      return;
    });
  };
  var fetchBytes = async (url, options) => {
    const controller = new AbortController;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
    let reader;
    try {
      const doFetch = options.fetchImpl ?? fetch;
      const response = await doFetch(url, requestInit(controller.signal));
      if (response.status === 404) {
        release(controller, response.body);
        return fail("not-found");
      }
      if (response.status !== 200) {
        release(controller, response.body);
        return fail("http-error", String(response.status));
      }
      if (response.body === null)
        return ok(new Uint8Array(0));
      reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      for (;; ) {
        const step = await reader.read();
        if (step.done)
          break;
        const chunk = step.value;
        if (total + chunk.byteLength > options.maxBytes) {
          release(controller, reader);
          return fail("too-large");
        }
        chunks.push(chunk);
        total += chunk.byteLength;
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return ok(bytes);
    } catch {
      release(controller, reader);
      return timedOut ? fail("timeout") : fail("network");
    } finally {
      clearTimeout(timer);
    }
  };
  var fetchText = async (url, options) => {
    const bytes = await fetchBytes(url, options);
    if (!bytes.ok)
      return bytes;
    try {
      return ok(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.value));
    } catch {
      return fail("bad-text");
    }
  };

  var PER_PAGE = 100;
  var API_ROOT = "https://api.github.com/repos";
  var LOGIN_PATTERN2 = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;
  var isRecord2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  var fetchOptions = (options) => options?.fetchImpl === undefined ? { maxBytes: FIXED.apiBytesMax, timeoutMs: FIXED.fetchTimeoutMs } : { maxBytes: FIXED.apiBytesMax, timeoutMs: FIXED.fetchTimeoutMs, fetchImpl: options.fetchImpl };
  var issueUrl = (address, issue) => `${API_ROOT}/${encodeURIComponent(address.owner)}/${encodeURIComponent(address.repo)}/issues/${issue}`;
  var readFailure = (failure2) => {
    const detail = failure2.detail;
    if (failure2.code === "http-error" && (detail === "403" || detail === "429")) {
      return fail("rate-limited", detail);
    }
    return detail === undefined ? fail(failure2.code) : fail(failure2.code, detail);
  };
  var parseJson = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return;
    }
  };
  var parseAuthor2 = (value) => {
    if (!isRecord2(value))
      return null;
    const login = value["login"];
    if (typeof login !== "string" || !LOGIN_PATTERN2.test(login))
      return null;
    const id = value["id"];
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
      return null;
    return { login, id };
  };
  var readBody = (value) => {
    if (!Object.hasOwn(value, "body"))
      return ok("");
    const body = value["body"];
    if (body === null)
      return ok("");
    if (typeof body !== "string")
      return fail("bad-response", "body");
    return ok(body);
  };
  var readLabels = (value) => {
    if (!Array.isArray(value))
      return fail("bad-response", "labels");
    const labels = [];
    for (const item of value) {
      if (typeof item === "string") {
        labels.push(item);
        continue;
      }
      const name = isRecord2(item) ? item["name"] : undefined;
      if (typeof name === "string")
        labels.push(name);
    }
    return ok(labels);
  };
  var parseIssue = (value, expected) => {
    if (!isRecord2(value))
      return fail("bad-response");
    if (Object.hasOwn(value, "pull_request"))
      return fail("bad-response", "pull_request");
    if (value["number"] !== expected)
      return fail("bad-response", "number");
    const state = value["state"];
    if (state !== "open" && state !== "closed")
      return fail("bad-response", "state");
    const title = value["title"];
    if (typeof title !== "string")
      return fail("bad-response", "title");
    const body = readBody(value);
    if (!body.ok)
      return body;
    const author = parseAuthor2(value["user"]);
    if (author === null)
      return fail("bad-response", "user");
    const labels = readLabels(value["labels"]);
    if (!labels.ok)
      return labels;
    return ok({
      number: expected,
      state,
      title,
      body: body.value,
      author,
      labels: labels.value
    });
  };
  var parseComment = (value) => {
    if (!isRecord2(value))
      return { user: null, body: null };
    const rawUser = value["user"];
    const login = isRecord2(rawUser) ? rawUser["login"] : undefined;
    const type = isRecord2(rawUser) ? rawUser["type"] : undefined;
    const user = typeof login === "string" && typeof type === "string" ? { login, type } : null;
    const rawBody = value["body"];
    const body = typeof rawBody === "string" ? rawBody : null;
    return { user, body };
  };
  var readComments = (value) => {
    if (!Array.isArray(value))
      return fail("bad-response", "comments");
    return ok(value.map(parseComment));
  };
  var loadIssue = async (address, issue, options) => {
    if (!Number.isSafeInteger(issue) || issue < 1)
      return fail("bad-response", "issue");
    const url = issueUrl(address, issue);
    const limited = fetchOptions(options);
    const issueText = await fetchText(url, limited);
    if (!issueText.ok)
      return readFailure(issueText);
    const issueJson = parseJson(issueText.value);
    if (issueJson === undefined)
      return fail("bad-response");
    const parsedIssue = parseIssue(issueJson, issue);
    if (!parsedIssue.ok)
      return parsedIssue;
    const commentsText = await fetchText(`${url}/comments?per_page=${PER_PAGE}`, limited);
    if (!commentsText.ok)
      return readFailure(commentsText);
    const commentsJson = parseJson(commentsText.value);
    if (commentsJson === undefined)
      return fail("bad-response");
    const parsedComments = readComments(commentsJson);
    if (!parsedComments.ok)
      return parsedComments;
    return ok({
      issue: parsedIssue.value,
      comments: parsedComments.value,
      truncated: Array.isArray(commentsJson) && commentsJson.length >= PER_PAGE
    });
  };

  var ADOPTED_AT = "1970-01-01T00:00:00Z";
  var OK_LABEL = "check:ok";
  var shapeCodeOf = (parsed) => parsed.kind === "invalid" ? parsed.code : parsed.kind === "skip" ? "skip" : null;
  var nameOf = (parsed) => parsed.kind === "ok" ? parsed.submission.name : parsed.kind === "invalid" ? parsed.name : null;
  var libNamesOf = (room) => new Set(room.config.lib.map((lib) => lib.name));
  var withCandidate2 = async (room, issue, submission, sources, replaces) => {
    const entry = await makeEntry({
      name: submission.name,
      code: submission.code,
      issue: issue.number,
      author: issue.author,
      adoptedAt: ADOPTED_AT
    });
    const manifest = upsertModule(room.manifest, entry, { replace: replaces });
    if (!manifest.ok)
      return null;
    if (manifest.value.modules.length > FIXED.modulesMax)
      return null;
    return { config: room.config, manifest: manifest.value, sources };
  };
  var makeReview = async (room, issue, comments) => {
    const parsed = parseSubmission({ title: issue.title, body: issue.body }, { entryName: room.config.entry, codeCharsMax: room.config.limits.codeChars });
    const marker = pickBotMarker(comments);
    const digest = parsed.kind === "ok" ? await submissionDigest(parsed.submission.name, parsed.submission.code) : null;
    const verdict = decideVerdict({
      state: issue.state,
      hasOkLabel: issue.labels.includes(OK_LABEL),
      marker,
      parsed,
      digest
    });
    const base = {
      verdict,
      markerCode: marker === null ? null : marker.code,
      shapeCode: shapeCodeOf(parsed),
      name: nameOf(parsed),
      digest,
      code: parsed.kind === "ok" ? parsed.submission.code : null,
      author: { login: issue.author.login, id: issue.author.id },
      issue: issue.number,
      staticOnly: marker !== null && marker.code === "ok-static" && digest !== null && marker.digest === digest
    };
    if (parsed.kind !== "ok") {
      return { ...base, replaces: false, missing: [], newlyFloating: [], room: null };
    }
    const plan = planCandidate(room.sources, libNamesOf(room), parsed.submission);
    return {
      ...base,
      replaces: plan.replaces,
      missing: plan.missing,
      newlyFloating: plan.newlyFloating,
      room: await withCandidate2(room, issue, parsed.submission, plan.sources, plan.replaces)
    };
  };

  var limitedOptions = (maxBytes, options) => options?.fetchImpl === undefined ? { maxBytes, timeoutMs: FIXED.fetchTimeoutMs } : { maxBytes, timeoutMs: FIXED.fetchTimeoutMs, fetchImpl: options.fetchImpl };
  var loadRoom = async (address, options) => {
    const text = await fetchText(roomFileUrl(address, "bundle.json"), limitedOptions(FIXED.bundleBytesMax, options));
    if (!text.ok)
      return text;
    const parsed = await parseBundle(text.value);
    if (!parsed.ok)
      return parsed;
    return ok(parsed.value);
  };
  var loadLibs = async (address, config, options) => {
    const libs = new Map;
    for (const entry of config.lib) {
      const fetched = await fetchBytes(roomFileUrl(address, entry.path), limitedOptions(entry.bytes, options));
      if (!fetched.ok)
        return fetched;
      if (fetched.value.byteLength !== entry.bytes)
        return fail("lib-mismatch", entry.name);
      if (await sha256Hex(fetched.value) !== entry.sha256)
        return fail("lib-mismatch", entry.name);
      let code;
      try {
        code = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fetched.value);
      } catch {
        return fail("bad-text", entry.name);
      }
      libs.set(entry.name, code);
    }
    return ok(libs);
  };
  var roomModules = (room, floating) => {
    const modules = [];
    for (const entry of room.manifest.modules) {
      if (entry.issue === null)
        continue;
      modules.push({
        name: entry.name,
        author: entry.author.login,
        order: modules.length,
        floating: floating.has(entry.name)
      });
    }
    return modules;
  };
  var libPairs = (room, libs) => {
    const pairs = [];
    for (const entry of room.config.lib) {
      const code = libs.get(entry.name);
      if (code === undefined)
        return fail("lib-mismatch", entry.name);
      pairs.push([entry.name, code]);
    }
    return ok(pairs);
  };
  var makeBoot = async (room, libs) => {
    const entry = room.config.entry;
    if (!room.manifest.modules.some((module) => module.name === entry)) {
      return fail("entry-missing", entry);
    }
    const pairs = libPairs(room, libs);
    if (!pairs.ok)
      return pairs;
    const libNames = new Set(room.config.lib.map((lib) => lib.name));
    const plan = planLoad(room.sources, libNames);
    if (plan.floating.includes(entry))
      return fail("entry-floating", entry);
    const sources = [];
    for (const name of plan.order) {
      const code = room.sources.get(name);
      if (code === undefined)
        return fail("bad-bundle", name);
      sources.push([name, code]);
    }
    return ok({
      entry,
      sources,
      libs: pairs.value,
      modules: roomModules(room, new Set(plan.floating)),
      seed: await roomVersion(room.manifest),
      width: room.config.limits.canvasWidth,
      height: room.config.limits.canvasHeight
    });
  };

  var STOP_CODES = [
    "silent",
    "flood",
    "bad-message",
    "worker-error",
    "lock-failed",
    "load-error",
    "no-start",
    "start-error",
    "boot-error",
    "canvas-too-large"
  ];
  var isPlainObject = (value) => {
    if (typeof value !== "object" || value === null)
      return false;
    try {
      const proto = Object.getPrototypeOf(value);
      return proto === Object.prototype || proto === null;
    } catch {
      return false;
    }
  };
  var hasOnlyKeys2 = (value, expected) => {
    const keys = Object.keys(value);
    if (keys.length !== expected.length)
      return false;
    for (const key of expected) {
      if (!Object.hasOwn(value, key))
        return false;
    }
    return true;
  };
  var isSafeCount = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  var isStopCode = (value) => {
    if (typeof value !== "string")
      return false;
    return STOP_CODES.some((code) => code === value);
  };
  var parseBridgeMessage = (data) => {
    try {
      if (!isPlainObject(data))
        return;
      const t = data["t"];
      if (t === "running") {
        return hasOnlyKeys2(data, ["t"]) ? { t } : undefined;
      }
      if (t === "error") {
        if (!hasOnlyKeys2(data, ["t", "detail"]))
          return;
        const detail = data["detail"];
        return typeof detail === "string" ? { t, detail } : undefined;
      }
      if (t === "stats") {
        if (!hasOnlyKeys2(data, ["t", "frames"]))
          return;
        const frames = data["frames"];
        return isSafeCount(frames) ? { t, frames } : undefined;
      }
      if (t === "stopped") {
        if (!hasOnlyKeys2(data, ["t", "code", "detail"]))
          return;
        const code = data["code"];
        const detail = data["detail"];
        if (!isStopCode(code) || typeof detail !== "string")
          return;
        return { t, code, detail };
      }
      return;
    } catch {
      return;
    }
  };

  var createGapWatch = (limits) => {
    let lastTick = null;
    let lastFrame = null;
    let visible = true;
    let stalled = false;
    const restart = (now) => {
      lastTick = now;
      lastFrame = now;
      stalled = false;
    };
    return {
      frame: (now) => {
        lastFrame = now;
        stalled = false;
      },
      tick: (now) => {
        if (!visible) {
          lastTick = now;
          stalled = false;
          return;
        }
        if (lastTick === null) {
          restart(now);
          return;
        }
        if (now - lastTick > limits.tickSlackMs) {
          restart(now);
          return;
        }
        lastTick = now;
        if (lastFrame === null)
          lastFrame = now;
        stalled = now - lastFrame > limits.gapMs;
      },
      setVisible: (value, now) => {
        if (value === visible)
          return;
        visible = value;
        stalled = false;
        if (value)
          restart(now);
      },
      isStalled: () => stalled
    };
  };

  var TEXT_AREA_PX = 180;
  var isPlainObject2 = (value) => {
    if (typeof value !== "object" || value === null)
      return false;
    try {
      const proto = Object.getPrototypeOf(value);
      return proto === Object.prototype || proto === null;
    } catch {
      return false;
    }
  };
  var isReadyMessage = (data) => {
    try {
      if (!isPlainObject2(data))
        return false;
      return Object.keys(data).length === 1 && data["t"] === "ready";
    } catch {
      return false;
    }
  };
  var createStopOnce = (onStop) => {
    let done = false;
    return {
      stop: (code, detail) => {
        if (done)
          return;
        done = true;
        onStop(code, detail);
      },
      isStopped: () => done
    };
  };
  var startRun = (host, room, on) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("title", "隔離した枠");
    iframe.src = "frame.html";
    iframe.style.aspectRatio = `${room.width} / ${room.height}`;
    iframe.style.height = `calc(100cqw * ${room.height / room.width} + ${TEXT_AREA_PX}px)`;
    const gap = createGapWatch({ gapMs: FIXED.frameGapMs, tickSlackMs: FIXED.frameTickSlackMs });
    let visible = document.visibilityState === "visible";
    gap.setVisible(visible, performance.now());
    let port = null;
    let ready = false;
    let raf = 0;
    let tickTimer = null;
    let readyTimer = null;
    const cleanup = () => {
      window.removeEventListener("message", onWindowMessage);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (raf !== 0) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (tickTimer !== null) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      if (readyTimer !== null) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
      if (port !== null) {
        port.onmessage = null;
        port.close();
        port = null;
      }
      iframe.remove();
    };
    const finish = createStopOnce((code, detail) => {
      cleanup();
      on.stopped(code, detail);
    });
    const send = (message) => {
      port?.postMessage(message);
    };
    const onPortMessage = (event) => {
      if (finish.isStopped())
        return;
      const message = parseBridgeMessage(event.data);
      if (message === undefined)
        return;
      switch (message.t) {
        case "running":
          on.running();
          return;
        case "stopped":
          finish.stop(message.code, message.detail);
          return;
        case "error":
          on.error(message.detail);
          return;
        case "stats":
          on.stats(message.frames);
          return;
      }
    };
    const handOff = () => {
      const target = iframe.contentWindow;
      if (target === null) {
        finish.stop("frame-error", "枠の窓がありません");
        return;
      }
      const channel = new MessageChannel;
      port = channel.port1;
      port.onmessage = onPortMessage;
      port.start();
      try {
        target.postMessage({ t: "port" }, "*", [channel.port2]);
      } catch {
        finish.stop("frame-error", "枠に通り道を渡せません");
        return;
      }
      send({ t: "boot", room });
      send({ t: "visible", value: visible });
    };
    const onWindowMessage = (event) => {
      if (finish.isStopped() || ready)
        return;
      if (event.source !== iframe.contentWindow)
        return;
      if (event.origin !== "null")
        return;
      if (!isReadyMessage(event.data))
        return;
      ready = true;
      if (readyTimer !== null) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
      handOff();
    };
    const onVisibilityChange = () => {
      if (finish.isStopped())
        return;
      visible = document.visibilityState === "visible";
      gap.setVisible(visible, performance.now());
      send({ t: "visible", value: visible });
    };
    const onFrame = () => {
      if (finish.isStopped())
        return;
      gap.frame(performance.now());
      raf = requestAnimationFrame(onFrame);
    };
    const onTick = () => {
      if (finish.isStopped())
        return;
      gap.tick(performance.now());
      if (gap.isStalled())
        finish.stop("render-stall", "描画が止まりました");
    };
    window.addEventListener("message", onWindowMessage);
    document.addEventListener("visibilitychange", onVisibilityChange);
    host.append(iframe);
    readyTimer = window.setTimeout(() => {
      if (!ready)
        finish.stop("frame-error", "枠が時間内に用意できません");
    }, FIXED.frameReadyMs);
    raf = requestAnimationFrame(onFrame);
    tickTimer = window.setInterval(onTick, FIXED.frameTickMs);
    return {
      stop: () => {
        finish.stop("user", "");
      }
    };
  };

  var ROOM_TEXT_LABEL = "部屋から来た文字です";
  var element = (tag, className) => {
    const node = document.createElement(tag);
    if (className !== undefined)
      node.className = className;
    return node;
  };
  var safeText = (value, maxChars = FIXED.textCharsPerCall) => clip(stripControls(typeof value === "string" ? value : ""), maxChars);
  var singleLineText = (value, maxChars = FIXED.textCharsPerCall) => safeText(value, maxChars).replace(/[\n\t]+/g, " ");
  var appRoot = () => {
    const existing = document.getElementById("app");
    if (existing !== null)
      return existing;
    const created = element("main");
    created.id = "app";
    document.body.append(created);
    return created;
  };
  var clearApp = () => {
    const root = appRoot();
    root.replaceChildren();
    return root;
  };
  var setBodyState = (state) => {
    document.body.dataset.state = state;
  };
  var setBodyCode = (code) => {
    if (code === null)
      delete document.body.dataset.code;
    else
      document.body.dataset.code = code;
  };
  var h1 = (text) => {
    const node = element("h1");
    node.textContent = text;
    return node;
  };
  var h2 = (text) => {
    const node = element("h2");
    node.textContent = text;
    return node;
  };
  var paragraph = (text, className) => {
    const node = element("p", className);
    node.textContent = text;
    return node;
  };
  var note = (text) => paragraph(text, "note");
  var textValue = (text) => {
    const node = element("span");
    node.textContent = text;
    return node;
  };
  var button = (label, action) => {
    const node = element("button");
    node.type = "button";
    node.dataset.action = action;
    node.textContent = label;
    return node;
  };
  var facts = (rows) => {
    const list = element("dl", "facts");
    for (const [term, value] of rows) {
      const name = element("dt");
      name.textContent = term;
      const detail = element("dd");
      detail.append(value);
      list.append(name, detail);
    }
    return list;
  };
  var roomTextValue = (value, field, maxChars = FIXED.textCharsPerCall) => {
    const section = element("section", "room-text");
    section.append(paragraph(ROOM_TEXT_LABEL, "room-text-label"));
    const line = element("p", "room-text-line");
    line.textContent = singleLineText(value, maxChars);
    if (field !== undefined)
      line.dataset.field = field;
    section.append(line);
    return section;
  };
  var roomTextBlock = (maxChars = FIXED.textCharsPerCall) => {
    const section = element("section", "room-text");
    const lines = element("div", "room-text-lines");
    section.append(paragraph(ROOM_TEXT_LABEL, "room-text-label"), lines);
    const add = (text) => {
      const line = element("p", "room-text-line");
      line.textContent = safeText(text, maxChars);
      lines.append(line);
    };
    const clear = () => {
      lines.replaceChildren();
    };
    return { section, add, clear };
  };
  var nameList = (names) => {
    const list = element("ul", "names");
    for (const name of names) {
      const item = element("li");
      item.textContent = safeText(name, FIXED.titleChars);
      list.append(item);
    }
    return list;
  };
  var codeLineNode = (line) => {
    const node = element("div", "code-line");
    node.dataset.line = String(line.number);
    for (const part of line.parts) {
      if (part.hidden) {
        const hidden = element("span", "hidden-char");
        hidden.textContent = part.text;
        node.append(hidden);
      } else {
        node.append(document.createTextNode(part.text));
      }
    }
    return node;
  };
  var showMessagePage = (state, title, lines) => {
    const root = clearApp();
    root.append(h1(title));
    for (const line of lines)
      root.append(paragraph(line));
    setBodyState(state);
    setBodyCode(null);
  };

  var prepareBoot = async (address, room) => {
    const libs = await loadLibs(address, room.config);
    if (!libs.ok)
      return libs;
    return makeBoot(room, libs.value);
  };
  var WARNING = "第三者が書いたコードが動いています。パスワードなどを入力しないでください。";
  var STALL_NOTE = "画面の動きが戻らないときは、このタブを閉じてください。";
  var createRunPanel = (options) => {
    const panel = element("section", "run-panel");
    const warning = paragraph(WARNING, "warning");
    warning.hidden = true;
    const actions = element("div", "actions");
    const status = paragraph("", "run-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const frameHost = element("div", "run-frame");
    const stallNote = paragraph(STALL_NOTE, "run-note");
    stallNote.hidden = true;
    const roomText = roomTextBlock();
    roomText.section.hidden = true;
    const baseTitle = document.title;
    let generation = 0;
    let active = null;
    let errorCount = 0;
    let started = false;
    const entries = options.targets.map((target) => {
      const node = button(target.label, target.action);
      node.addEventListener("click", () => {
        begin(target);
      });
      return { target, node };
    });
    const stopButton = button("止める", "stop");
    stopButton.hidden = true;
    stopButton.addEventListener("click", () => {
      active?.stop();
    });
    actions.append(...entries.map((entry) => entry.node), stopButton);
    panel.append(h2("動かす"), warning, actions, status, frameHost, stallNote, roomText.section);
    let current = null;
    const showButtons = (running, again) => {
      for (const entry of entries) {
        entry.node.hidden = running && entry.target.action === current;
        entry.node.textContent = again ? entry.target.againLabel : entry.target.label;
      }
      stopButton.hidden = !running;
    };
    const clearRoomText = () => {
      roomText.clear();
      roomText.section.hidden = true;
    };
    const addRoomText = (text) => {
      roomText.add(text);
      roomText.section.hidden = false;
    };
    const stopActive = () => {
      const current2 = active;
      active = null;
      current2?.stop();
    };
    const onStopped = (code, detail) => {
      active = null;
      showButtons(false, true);
      warning.hidden = true;
      const stalled = code === "render-stall";
      stallNote.hidden = !stalled;
      status.textContent = runCodeText(code);
      if (stalled)
        document.title = `${baseTitle}（止まりました）`;
      const fromRoom = roomDetail(code, detail);
      if (fromRoom !== null)
        addRoomText(fromRoom);
      setBodyState("stopped");
      setBodyCode(code);
    };
    const onUnexpected = () => {
      active = null;
      showButtons(false, true);
      warning.hidden = true;
      stallNote.hidden = true;
      status.textContent = runCodeText("unexpected");
      setBodyState("failed");
      setBodyCode("unexpected");
    };
    const begin = async (target) => {
      const gen = generation + 1;
      generation = gen;
      stopActive();
      current = target.action;
      started = true;
      errorCount = 0;
      clearRoomText();
      stallNote.hidden = true;
      warning.hidden = true;
      for (const entry of entries)
        entry.node.hidden = true;
      stopButton.hidden = true;
      status.textContent = "準備しています";
      document.title = baseTitle;
      setBodyState("loading");
      setBodyCode(null);
      let prepared;
      try {
        prepared = await target.prepare();
      } catch {
        if (gen === generation)
          onUnexpected();
        return;
      }
      if (gen !== generation)
        return;
      if (!prepared.ok) {
        active = null;
        showButtons(false, true);
        status.textContent = roomCodeText(prepared.code);
        setBodyState("failed");
        setBodyCode(prepared.code);
        return;
      }
      showButtons(true, true);
      warning.hidden = false;
      status.textContent = "起動しています";
      try {
        active = startRun(frameHost, prepared.value, {
          running: () => {
            if (gen !== generation)
              return;
            showButtons(true, true);
            warning.hidden = false;
            stallNote.hidden = true;
            status.textContent = "部屋のコードが動いています";
            setBodyState("running");
            setBodyCode(null);
          },
          stopped: (code, detail) => {
            if (gen !== generation)
              return;
            onStopped(code, detail);
          },
          error: (detail) => {
            if (gen !== generation)
              return;
            if (errorCount >= FIXED.errorsMax)
              return;
            errorCount += 1;
            addRoomText(detail);
          },
          stats: () => {
            return;
          }
        });
      } catch {
        onUnexpected();
      }
    };
    showButtons(false, started);
    return panel;
  };

  var COPY_FAILED = "写せませんでした。選んで写してください";
  var copyDigest = async (digest, status) => {
    if (digest === null)
      return;
    const clipboard = navigator.clipboard;
    if (clipboard === undefined) {
      status.textContent = COPY_FAILED;
      return;
    }
    try {
      await clipboard.writeText(digest);
      status.textContent = "写しました。";
    } catch {
      status.textContent = COPY_FAILED;
    }
  };
  var showFailure = (text, code) => {
    document.title = "下見を開けません - jamroom";
    const root = clearApp();
    root.append(h1("下見を開けません"), paragraph(text));
    setBodyState("failed");
    setBodyCode(code);
  };
  var field = (name, text) => {
    const node = textValue(text);
    node.dataset.field = name;
    return node;
  };
  var showReview = (address, issue, room, review, truncated) => {
    document.title = `${address.slug} #${issue} の下見 - jamroom`;
    const root = clearApp();
    const banner = paragraph("まだ採用されていない提出です", "banner");
    root.append(banner, h1("提出の下見"));
    const copyStatus = paragraph("", "copy-status");
    copyStatus.setAttribute("aria-live", "polite");
    const digest = element("code", "digest");
    digest.dataset.field = "digest";
    digest.textContent = review.digest ?? "（ありません）";
    const digestRow = element("span", "digest-row");
    digestRow.append(digest);
    if (review.digest !== null) {
      const copy = button("写す", "copy-digest");
      copy.addEventListener("click", () => {
        copyDigest(review.digest, copyStatus);
      });
      digestRow.append(copy);
    }
    root.append(facts([
      ["置き場", field("slug", address.slug)],
      ["イシュー", textValue(`#${issue}`)],
      ["作者", field("author", `${safeText(review.author.login)}（ID: ${review.author.id}）`)],
      ["名前", field("name", review.name === null ? "（読めません）" : safeText(review.name))],
      ["提出のハッシュ値", digestRow]
    ]));
    root.append(copyStatus);
    root.append(h2("判定"));
    const verdict = paragraph("", "verdict-value");
    verdict.dataset.field = "verdict";
    verdict.dataset.value = review.verdict;
    verdict.textContent = verdictText(review.verdict);
    root.append(verdict);
    root.append(paragraph(`印の符号: ${review.markerCode ?? "なし"}`, "marker"));
    if (review.shapeCode !== null) {
      root.append(paragraph(`形の符号: ${shapeText(review.shapeCode)}`, "shape"));
    }
    if (review.staticOnly)
      root.append(paragraph("実行の検査はしていません。", "notice"));
    if (review.missing.length > 0) {
      root.append(h2("部屋に無い読み込み先"));
      root.append(nameList(review.missing));
    }
    if (review.newlyFloating.length > 0) {
      root.append(h2("この提出を入れると動かなくなる貢献"));
      root.append(nameList(review.newlyFloating));
    }
    if (review.replaces)
      root.append(paragraph("同じ名前の貢献を置き換えます。", "notice"));
    if (truncated) {
      root.append(paragraph("コメントが多く、検査の結果を見落としている可能性があります。", "notice"));
    }
    root.append(h2("取り出したコード"));
    if (review.code === null) {
      root.append(note("提出からコードを取り出せませんでした。"));
    } else {
      const view = splitCodeLines(review.code);
      root.append(note(`${view.lineCount}行・${view.charCount}文字`));
      const box = element("div", "code");
      box.dataset.field = "code";
      for (const line of view.lines)
        box.append(codeLineNode(line));
      root.append(box);
    }
    const candidate = review.room;
    const targets = [
      {
        action: "run-current",
        label: "いまの部屋を動かす",
        againLabel: "もう一度動かす（いまの部屋）",
        prepare: () => prepareBoot(address, room)
      }
    ];
    if (candidate !== null) {
      targets.push({
        action: "run-candidate",
        label: "この提出を入れた部屋を動かす",
        againLabel: "もう一度動かす（この提出を入れた部屋）",
        prepare: () => prepareBoot(address, candidate)
      });
    }
    root.append(createRunPanel({ targets }));
    root.append(paragraph("下見は、挙動の保証ではありません。", "disclaimer"));
    root.append(note("数秒だけおとなしく動き、あとで振る舞いを変えるコードは書けます。"));
    setBodyState("ready");
    setBodyCode(null);
  };
  var renderReviewPage = async (address, issue) => {
    setBodyState("loading");
    setBodyCode(null);
    const room = await loadRoom(address);
    if (!room.ok) {
      showFailure(roomCodeText(room.code), room.code);
      return;
    }
    const info = await loadIssue(address, issue);
    if (!info.ok) {
      showFailure(issueCodeText(info.code), info.code);
      return;
    }
    const review = await makeReview(room.value, info.value.issue, info.value.comments);
    showReview(address, issue, room.value, review, info.value.truncated);
  };

  var contributionsOf = (room) => room.manifest.modules.filter((module) => module.issue !== null);
  var floatingNames = (room, floatingNames2) => {
    const floating = new Set(floatingNames2);
    return contributionsOf(room).filter((module) => floating.has(module.name)).map((module) => module.name);
  };
  var contributionList = (room) => {
    const list = element("ul", "contributions");
    for (const module of contributionsOf(room)) {
      const item = element("li");
      const name = element("span", "name");
      name.textContent = safeText(module.name, FIXED.titleChars);
      const author = element("span", "author");
      author.textContent = safeText(module.author.login, FIXED.titleChars);
      item.append(name, author);
      list.append(item);
    }
    return list;
  };
  var showFailure2 = (code) => {
    document.title = "この部屋を開けません - jamroom";
    const root = clearApp();
    root.append(h1("この部屋を開けません"), paragraph(roomCodeText(code)));
    setBodyState("failed");
    setBodyCode(code);
  };
  var showRoom = (address, room, floating, entryFloating) => {
    document.title = `${address.slug} - jamroom`;
    const root = clearApp();
    root.append(roomTextValue(room.config.title, "title", FIXED.titleChars));
    root.append(facts([
      ["置き場", textValue(address.slug)],
      ["貢献", textValue(String(contributionsOf(room).length))]
    ]));
    if (floating.length > 0) {
      root.append(h2("宙に浮いた貢献"));
      root.append(nameList(floating));
      root.append(note("読み込み先が無いため、この貢献は動きません。"));
    }
    if (entryFloating)
      root.append(paragraph("入口が動かない状態です。", "warning-text"));
    root.append(h2("使われる条件"));
    root.append(roomTextValue(room.config.license, undefined, FIXED.licenseChars));
    root.append(h2("貢献"));
    if (contributionsOf(room).length === 0) {
      root.append(note("まだ貢献はありません。"));
    } else {
      root.append(contributionList(room));
      root.append(note("作者はホストの申告です。"));
    }
    root.append(createRunPanel({
      targets: [
        {
          action: "run",
          label: "動かす",
          againLabel: "もう一度動かす",
          prepare: () => prepareBoot(address, room)
        }
      ]
    }));
    setBodyState("ready");
    setBodyCode(null);
  };
  var renderRoomPage = async (address) => {
    setBodyState("loading");
    setBodyCode(null);
    const loaded = await loadRoom(address);
    if (!loaded.ok) {
      showFailure2(loaded.code);
      return;
    }
    const room = loaded.value;
    const libNames = new Set(room.config.lib.map((lib) => lib.name));
    const plan = planLoad(room.sources, libNames);
    showRoom(address, room, floatingNames(room, plan.floating), plan.floating.includes(room.config.entry));
  };

  var showHomePage = () => {
    document.title = "jamroom 閲覧ページ";
    showMessagePage("home", "jamroom 閲覧ページ", [
      "GitHub のリポジトリを部屋として開く、静的なページです。",
      "住所の形は #gh/<持ち主>/<部屋> です。下見は #gh/<持ち主>/<部屋>/issue/<番号> です。",
      "部屋のページを開くと、題名と貢献の一覧が出ます。「動かす」を押すまで、部屋のコードは動きません。"
    ]);
    appRoot().append(note("閲覧に、GitHub のアカウントは要りません。"));
  };
  var showBadPage = () => {
    document.title = "住所の形が違います - jamroom";
    showMessagePage("bad", "住所の形が違います", [
      "住所の形は #gh/<持ち主>/<部屋> です。",
      "下見は #gh/<持ち主>/<部屋>/issue/<番号> です。"
    ]);
    appRoot().append(note("持ち主と部屋の名前には、GitHub のものを使ってください。"));
  };
  var showBlockedPage = () => {
    document.title = "この部屋は開けません - jamroom";
    showMessagePage("blocked", "この部屋は開けません", [
      "この部屋は、閲覧ページの管理者が止めています。"
    ]);
    appRoot().append(note("ほかの部屋は開けます。"));
  };
  var showRefused = () => {
    document.body.textContent = "ほかのサイトに埋め込まれているので動きません";
    document.body.dataset.state = "refused";
    delete document.body.dataset.code;
  };
  var showUnexpected = () => {
    try {
      document.title = "表示できません - jamroom";
      setBodyState("failed");
      setBodyCode("unexpected");
      const root = appRoot();
      root.replaceChildren(h1("このページを表示できません"), paragraph(runCodeText("unexpected")), note("ページを読み込み直してください。"));
    } catch {}
  };
  var dispatch = async () => {
    const route = parseViewerRoute(location.hash);
    if (route.kind === "home") {
      showHomePage();
      return;
    }
    if (route.kind === "bad") {
      showBadPage();
      return;
    }
    if (isBlocked(route.address)) {
      showBlockedPage();
      return;
    }
    if (route.kind === "room") {
      await renderRoomPage(route.address);
      return;
    }
    await renderReviewPage(route.address, route.issue);
  };
  var start = async () => {
    if (window.self !== window.top) {
      showRefused();
      return;
    }
    window.addEventListener("hashchange", () => {
      location.reload();
    });
    window.addEventListener("unhandledrejection", () => {
      showUnexpected();
    });
    window.addEventListener("error", () => {
      showUnexpected();
    });
    await dispatch();
  };
  start().catch(showUnexpected);
})();
