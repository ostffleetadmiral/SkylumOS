import { INFER_BACKENDS } from "../../skylum/infer.js";

export function mountInfer(root, ctx) {
  let generation = 0;
  const doc = root.ownerDocument;
  const inf = ctx.os.skylum.infer;

  const kindSel = doc.createElement("select");
  for (const k of INFER_BACKENDS) {
    const o = doc.createElement("option"); o.value = o.textContent = k;
    kindSel.append(o);
  }
  kindSel.value = inf.kind;
  const endpoint = doc.createElement("input");
  endpoint.placeholder = "endpoint (openai/llamacpp/whisper) or GGUF model URL (wllama)";
  endpoint.value = inf.kind === "wllama" ? (inf.modelUrl ?? "") : (inf.endpoint ?? "");
  const model = doc.createElement("input"); model.placeholder = "Model"; model.value = inf.model;
  const audio = doc.createElement("input"); audio.type = "file"; audio.accept = "audio/*";
  const prompt = doc.createElement("textarea"); prompt.placeholder = "Prompt";
  const badge = doc.createElement("p");
  badge.className = "infer-badge";
  const paintBadge = () => {
    const detail = inf.kind === "wllama"
      ? `wllama ${inf.modelLoaded ? "· model loaded" : "· no model"}`
      : (inf.endpoint ?? "no endpoint");
    badge.textContent = inf.available
      ? `INFERENCE ON · ${inf.kind} · ${detail} · model ${inf.model}`
      : `INFERENCE OFF — configure ${inf.kind} to enable.`;
  };
  paintBadge();

  const submit = doc.createElement("button"); submit.textContent = "Run inference";
  const output = doc.createElement("pre");
  const sealLine = res =>
    `${res.text}\n\nmodel=${res.model}\nusage=${JSON.stringify(res.usage)}\n` +
    `fnv1a64=${res.seal.fnv1a64.toString(16)}\n` +
    `sha256=${[...res.seal.sha256].map(b => b.toString(16).padStart(2, "0")).join("")}`;

  submit.onclick = async () => {
    const own = ++generation;
    inf.kind = kindSel.value;
    inf.model = model.value.trim() || "local";
    if (inf.kind === "wllama") inf.modelUrl = endpoint.value.trim() || inf.modelUrl;
    else inf.endpoint = endpoint.value.trim() || null;
    output.textContent = "Waiting for inference service…";
    paintBadge();
    try {
      const result = await inf.complete(prompt.value);
      if (!ctx.isCurrent() || own !== generation) return;
      output.textContent = sealLine(result);
    } catch (e) {
      if (ctx.isCurrent() && own === generation)
        output.textContent = `Inference unavailable: ${e.message}`;
    }
  };

  audio.onchange = async () => {
    const own = ++generation;
    if (!audio.files?.[0]) return;
    output.textContent = "Transcribing…";
    try {
      const res = await inf.transcribe(await audio.files[0].arrayBuffer(),
        { filename: audio.files[0].name });
      if (!ctx.isCurrent() || own !== generation) return;
      output.textContent = sealLine(res);
    } catch (e) {
      if (ctx.isCurrent() && own === generation)
        output.textContent = `Transcription unavailable: ${e.message}`;
    }
  };

  root.append(badge, kindSel, endpoint, model, prompt, submit,
    "audio transcription:", audio, output);
  return () => { generation++; };
}
