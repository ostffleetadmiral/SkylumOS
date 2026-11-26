// persist.js — SKYLUM persistence: .skcs volumes in OPFS.
// Origin Private File System is the real browser persistence lane
// (structured, no quota juggling, survives reloads). Capability-detected;
// reports honest availability — never a stub.

export const PERSIST_DIR = "skyos";

export function opfsSupported() {
  return typeof navigator !== "undefined" &&
         !!navigator.storage && typeof navigator.storage.getDirectory === "function";
}

async function persistDir() {
  if (!opfsSupported()) throw new Error("OPFS unavailable (needs secure context)");
  const root = await navigator.storage.getDirectory();
  return await root.getDirectoryHandle(PERSIST_DIR, { create: true });
}

// save an ITERON state volume (.skcs bytes) under `name`
export async function saveVolume(name, skcsBytes) {
  const d = await persistDir();
  const fh = await d.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(skcsBytes instanceof Uint8Array ? skcsBytes : new Uint8Array(skcsBytes));
  await w.close();
  return name;
}

// load a volume -> Uint8Array (.skcs bytes) or null
export async function loadVolume(name) {
  try {
    const d = await persistDir();
    const fh = await d.getFileHandle(name);
    const f = await fh.getFile();
    return new Uint8Array(await f.arrayBuffer());
  } catch (e) {
    if (e.name === "NotFoundError") return null;
    throw e;
  }
}

export async function listVolumes() {
  const d = await persistDir();
  const names = [];
  for await (const [name] of d.entries()) names.push(name);
  return names.sort();
}

export async function deleteVolume(name) {
  const d = await persistDir();
  await d.removeEntry(name);
}

// high-level: persist ITERON's current stateBlob
export async function saveIteron(iteron, name = "state.skcs") {
  return saveVolume(name, iteron.stateBlob);
}

export async function loadIteron(iteron, name = "state.skcs") {
  const bytes = await loadVolume(name);
  if (!bytes) return false;
  iteron.stateBlob = bytes;
  return true;
}

// aggregate namespace — survives ESM->classic-script stripping in the
// quine bundle where `import * as persist` has no equivalent.
export const persist = {
  PERSIST_DIR, opfsSupported, saveVolume, loadVolume,
  listVolumes, deleteVolume, saveIteron, loadIteron,
};
