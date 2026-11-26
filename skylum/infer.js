// infer.js — SKYLUM inference door contract.
// Inference is an OS service above ITERON: requests are envelopes,
// responses carry text + an ITERON seal (fnv1a64 + sha256 of the payload).
// Backends:
//   openai       — OpenAI-compatible chat endpoint (llama.cpp --server
//                  /v1/chat/completions, Ollama, remote) — POST endpoint
//   llamacpp     — native llama.cpp server: POST {endpoint}/completion
//   whisper-http — transcription: POST multipart {file,model} to endpoint
//                  (whisper.cpp /inference or OpenAI /v1/audio/transcriptions)
//   wllama       — in-browser llama.cpp via vendored @wllama/wllama ESM +
//                  single-thread wasm; models load by URL or OPFS-cached
//                  blob (wllama's own CacheManager persists downloads)
// No endpoint/model configured => honest unavailable error, never a
// fabricated completion. `fetch` stays injectable for the HTTP backends.

export const INFER_BACKENDS = Object.freeze(["openai", "llamacpp", "whisper-http", "wllama"]);
const WLLAMA_ESM = "./vendor/wllama/esm/index.js";
const WLLAMA_WASM = "./vendor/wllama/esm/single-thread/wllama.wasm";

export class InferenceDoor {
  constructor(iteron, {
    kind = null, endpoint = null, model = "local", timeoutMs = 30000,
    esmUrl = WLLAMA_ESM, wasmUrl = WLLAMA_WASM, modelUrl = null,
    nCtx = 2048, nThreads = 1, wllamaModule = null, fetchImpl = null,
  } = {}) {
    this.iteron = iteron;
    this.kind = kind ?? (wllamaModule ? "wllama" : "openai");
    this.endpoint = endpoint;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.esmUrl = esmUrl;
    this.wasmUrl = wasmUrl;
    this.modelUrl = modelUrl;
    this.nCtx = nCtx;
    this.nThreads = nThreads;
    this._wllamaModule = wllamaModule;
    this._w = null;
    this._modelLoaded = false;
    this._fetch = fetchImpl ?? ((...a) => fetch(...a));
  }

  get available() {
    if (this.kind === "wllama") return !!(this._wllamaModule || this.esmUrl);
    return !!this.endpoint;
  }
  get modelLoaded() { return this._modelLoaded; }

  // build the request envelope (pure — testable without fetch)
  envelope(prompt, { maxTokens = 256, system = null } = {}) {
    if (this.kind === "llamacpp") {
      return {
        prompt: system ? `${system}\n\n${prompt}` : prompt,
        n_predict: maxTokens, cache_prompt: false, stream: false,
      };
    }
    return {
      model: this.model,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt }],
      max_tokens: maxTokens, stream: false,
    };
  }

  _url(path = "") {
    return this.kind === "llamacpp" ? `${this.endpoint.replace(/\/+$/, "")}/completion`
      : this.endpoint + path;
  }

  async _post(body, opts = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this._fetch(this._url(opts.path ?? ""), {
        method: "POST",
        headers: body instanceof FormData ? {} : { "content-type": "application/json" },
        body: body instanceof FormData ? body : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally { clearTimeout(t); }
    if (!res.ok) throw new Error(`inference http ${res.status}`);
    return res.json();
  }

  async _wllama() {
    if (this._w) return this._w;
    // esmUrl/wasmUrl accept a URL string or raw bytes (Uint8Array/Blob —
    // e.g. inflated quine members); bytes are minted as blob: URLs since
    // wllama's pathConfig only consumes strings.
    const asUrl = v => typeof v === "string" ? v
      : URL.createObjectURL(v instanceof Blob ? v : new Blob([v]));
    const mod = this._wllamaModule ?? await import(/* @vite-ignore */ asUrl(this.esmUrl));
    this._w = new mod.Wllama(
      { "single-thread/wllama.wasm": asUrl(this.wasmUrl) },
      { parallel: 1, n_threads: this.nThreads },
    );
    if (this.modelUrl) {
      await this._w.loadModelFromUrl(this.modelUrl, { n_ctx: this.nCtx });
      this._modelLoaded = true;
    }
    return this._w;
  }

  // load a GGUF model into wllama (URL string or Uint8Array/Blob bytes).
  async loadModel(source) {
    const w = await this._wllama();
    const url = typeof source === "string" ? source
      : URL.createObjectURL(source instanceof Blob ? source : new Blob([source]));
    await w.loadModelFromUrl(url, { n_ctx: this.nCtx });
    this._modelLoaded = true;
  }

  // wllama's OPFS cache inventory — [] until a backend exists.
  async cachedModels() {
    if (!this._w?.cacheManager?.list) return [];
    return this._w.cacheManager.list();
  }

  // complete(prompt) -> {text, model, usage, seal}
  async complete(prompt, opts = {}) {
    if (this.kind === "wllama") {
      const w = await this._wllama();
      if (!this._modelLoaded) throw new Error("wllama backend: no model loaded");
      const text = await w.createCompletion(prompt,
        { nPredict: opts.maxTokens ?? 256, ...(opts.sampling ? { sampling: opts.sampling } : {}) });
      return this._seal(text, this.model, null);
    }
    if (!this.endpoint) throw new Error("inference door unavailable: no endpoint");
    const json = await this._post(this.envelope(prompt, opts));
    const text = this.kind === "llamacpp" ? (json.content ?? "")
      : (json.choices?.[0]?.message?.content ?? json.text ?? "");
    const usage = this.kind === "llamacpp"
      ? {
          prompt_tokens: json.tokens_evaluated ?? null,
          completion_tokens: json.tokens_predicted ?? null,
          per_second: json.timings?.predicted_per_second ?? null,
        }
      : (json.usage ?? null);
    return this._seal(text, json.model ?? this.model, usage);
  }

  // transcribe(audioBytes|Blob) -> {text, model, seal} — whisper-http only.
  async transcribe(audio, { filename = "audio.wav" } = {}) {
    if (this.kind !== "whisper-http")
      throw new Error(`transcribe unavailable on ${this.kind} backend`);
    if (!this.endpoint) throw new Error("inference door unavailable: no endpoint");
    const form = new FormData();
    form.append("file", audio instanceof Blob ? audio : new Blob([audio]), filename);
    form.append("response_format", "json");
    if (this.model) form.append("model", this.model);
    const json = await this._post(form);
    return this._seal(json.text ?? "", json.model ?? this.model, null);
  }

  _seal(text, model, usage) {
    const payload = new TextEncoder().encode(text);
    return {
      text, model, usage,
      seal: {
        fnv1a64: this.iteron.core.fnv1a64(payload),
        sha256: this.iteron.core.sha256(payload),
      },
    };
  }
}
