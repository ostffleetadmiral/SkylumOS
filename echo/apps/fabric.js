import { createFabricClient } from "../../skylum/fabric.js";

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function mountFabric(root, ctx) {
  let active = true;
  let generation = 0;
  const doc = root.ownerDocument;
  const title = doc.createElement("h2");
  title.textContent = "Skyloom Fabric";
  const status = doc.createElement("p");
  const refresh = doc.createElement("button");
  refresh.type = "button";
  refresh.textContent = "Refresh";
  const nodes = doc.createElement("pre");
  const jobs = doc.createElement("pre");
  const journal = doc.createElement("pre");
  const kind = doc.createElement("select");
  for (const value of ["probe", "skc.roundtrip", "claim.read", "infer.whisper"]) {
    const option = doc.createElement("option");
    option.value = value;
    option.textContent = value;
    kind.append(option);
  }
  const payload = doc.createElement("input");
  payload.type = "text";
  payload.maxLength = 220000;
  payload.placeholder = "probe: ignored · claim.read: claim name · skc.roundtrip: base64 · infer.whisper: base64 WAV";
  const submit = doc.createElement("button");
  submit.type = "button";
  submit.textContent = "Submit job";
  const feedback = doc.createElement("pre");
  // Under the Electron host the real head URL + bearer live in the main
  // process (SKYOS_FABRIC_URL / SKYOS_FABRIC_TOKEN); fabricRequest proxies
  // /v1 calls over IPC so the token never enters renderer JS. The
  // placeholder token only satisfies the client's local credential gate —
  // the proxy replaces it with the configured bearer upstream.
  const fabricHost = ctx.os?.host?.fabricRequest;
  const client = createFabricClient(typeof fabricHost === "function" ? {
    token: "electron-host",
    fetchImpl: async (url, options = {}) => {
      const target = new URL(url);
      const result = await fabricHost({
        path: `${target.pathname}${target.search}`,
        method: options.method || "GET",
        body: typeof options.body === "string" ? options.body : null,
      });
      return new Response(result.body, { status: result.status,
        headers: { "content-type": "application/json" } });
    },
  } : {});

  const update = async () => {
    const own = ++generation;
    status.textContent = "Checking head…";
    try {
      const [head, memberList, jobList, log] = await Promise.all([
        client.status(), client.nodes(), client.jobs(), client.journal(),
      ]);
      if (!active || !ctx.isCurrent() || own !== generation) return;
      status.textContent = `Head ${head.head?.id || head.node || "available"} · ${memberList.nodes?.length ?? 0} nodes · journal ${log.verification?.valid ? "verified" : "unverified"}`;
      nodes.textContent = JSON.stringify(memberList.nodes ?? memberList, null, 2);
      jobs.textContent = JSON.stringify(jobList.jobs ?? jobList, null, 2);
      journal.textContent = JSON.stringify((log.entries ?? []).slice(-20), null, 2);
    } catch (error) {
      if (active && ctx.isCurrent() && own === generation) {
        status.textContent = `Fabric unavailable: ${error.message}`;
        nodes.textContent = "";
        jobs.textContent = "";
        journal.textContent = "";
      }
    }
  };
  refresh.onclick = update;
  submit.onclick = async () => {
    if (payload.value.length > payload.maxLength) {
      feedback.textContent = `Input exceeds the ${payload.maxLength}-character UI limit.`;
      return;
    }
    try {
      const text = payload.value;
      let input = null;
      if (kind.value === "claim.read") input = { name: text };
      else if (kind.value === "skc.roundtrip" || kind.value === "infer.whisper") {
        if (!text || !BASE64_RE.test(text))
          throw new Error(`${kind.value} input must be canonical base64`);
        input = kind.value === "skc.roundtrip" ? { data: text } : { audio_b64: text, filename: "ui.wav" };
      }
      const result = await client.submitJob({ kind: kind.value, input });
      feedback.textContent = JSON.stringify(result, null, 2);
      update();
    } catch (error) {
      feedback.textContent = `Job rejected: ${error.message}`;
    }
  };
  const section = (label, element) => {
    const heading = doc.createElement("h3");
    heading.textContent = label;
    root.append(heading, element);
  };
  root.append(title, status, refresh, kind, payload, submit, feedback);
  section("Nodes", nodes);
  section("Jobs", jobs);
  section("Journal tail", journal);
  update();
  const timer = setInterval(update, 5000);
  return () => { active = false; generation++; clearInterval(timer); };
}
