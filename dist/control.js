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

  // src/control/control.ts
  var CONTROL_WORKER = `
const describe = (error) => (error && error.name ? error.name + ": " + error.message : String(error));

const fetchCors = async (url) => {
  try {
    const response = await fetch(url, { cache: "no-store" });
    let jsonOk = false;
    try {
      JSON.parse(await response.text());
      jsonOk = true;
    } catch (error) {
      jsonOk = false;
    }
    return { reached: true, status: response.status, jsonOk: jsonOk, detail: "status=" + response.status };
  } catch (error) {
    return { reached: false, status: 0, jsonOk: false, detail: describe(error) };
  }
};

const fetchNoCors = async (url) => {
  try {
    const response = await fetch(url, { mode: "no-cors", cache: "no-store" });
    return {
      reached: true,
      status: response.status,
      detail: "type=" + response.type + " status=" + response.status
    };
  } catch (error) {
    return { reached: false, status: 0, detail: describe(error) };
  }
};

const xhrProbe = (url) =>
  new Promise((resolve) => {
    try {
      const request = new XMLHttpRequest();
      request.open("GET", url);
      request.onload = () => resolve({ reached: true, status: request.status, detail: "status=" + request.status });
      request.onerror = () => resolve({ reached: false, status: 0, detail: "error イベント" });
      request.send();
    } catch (error) {
      resolve({ reached: false, status: 0, detail: describe(error) });
    }
  });

const importRoom = async (url) => {
  let contentType = "";
  let fetched = false;
  let fetchDetail = "";
  try {
    const response = await fetch(url, { cache: "no-store" });
    fetched = true;
    contentType = response.headers.get("content-type") || "";
  } catch (error) {
    fetchDetail = describe(error);
  }
  try {
    const namespace = await import(url);
    const names = namespace ? Object.keys(namespace) : [];
    return { reached: fetched, contentType: contentType, importOk: true, exports: names, detail: fetchDetail };
  } catch (error) {
    return {
      reached: fetched,
      contentType: contentType,
      importOk: false,
      exports: [],
      detail: describe(error)
    };
  }
};

self.onmessage = async (event) => {
  const data = event.data || {};
  if (!data || data.type !== "run") return;
  const target = typeof data.target === "string" ? data.target : "";
  const moduleUrl = typeof data.moduleUrl === "string" ? data.moduleUrl : "";
  const results = {};
  results["s2c-fetch-cors"] = await fetchCors(target);
  results["s2c-fetch-nocors"] = await fetchNoCors(target);
  results["s2c-xhr"] = await xhrProbe(target);
  results["s2c-import-room"] = await importRoom(moduleUrl);
  self.postMessage({ type: "control-results", results: results });
};
`;
  var params = new URLSearchParams(location.search);
  var target = params.get("target") ?? "";
  var moduleUrl = params.get("module") ?? "";
  var output = document.getElementById("out");
  var show = (text) => {
    if (output !== null)
      output.textContent = text;
  };
  var deliver = (results) => {
    if (window.parent !== window) {
      window.parent.postMessage({ type: "control-results", results }, location.origin);
    }
    show(JSON.stringify(results, null, 2));
  };
  if (target === "" || moduleUrl === "") {
    show("target と module の両方が必要です");
  } else {
    const source = URL.createObjectURL(new Blob([CONTROL_WORKER], { type: "text/javascript" }));
    const worker = new Worker(source);
    worker.onmessage = (event) => {
      const data = asRecord(event.data);
      if (data === undefined || data.type !== "control-results")
        return;
      worker.terminate();
      URL.revokeObjectURL(source);
      deliver(data.results);
    };
    worker.onerror = (event) => {
      show(`Worker の error: ${event.message}`);
    };
    worker.postMessage({ type: "run", target, moduleUrl });
  }
})();
