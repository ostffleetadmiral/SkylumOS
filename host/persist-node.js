import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export function createNodePersistence(rootDir) {
  let root = resolve(rootDir);
  const target = name => join(root, validateName(name));
  const setRoot = nextRoot => { root = resolve(nextRoot); };
  return Object.freeze({
    available: true,
    async saveVolume(name, bytes) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const path = target(name);
      const temp = join(dirname(path), `.${name}.${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(temp, "wx", 0o600);
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temp, path);
      } catch (error) {
        await handle?.close().catch(() => {});
        await rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      return name;
    },
    async loadVolume(name) {
      try { return new Uint8Array(await readFile(target(name))); }
      catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async listVolumes() {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const entries = await readdir(root, { withFileTypes: true });
      return entries.filter(entry => entry.isFile() && !entry.name.startsWith(".") &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry.name)).map(entry => entry.name).sort();
    },
    async deleteVolume(name) {
      try { await rm(target(name)); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        return false;
      }
      return true;
    },
    setRoot,
    root,
  });
}

function validateName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ||
      name === "." || name === "..") throw new Error("volume_name_invalid");
  return name;
}
