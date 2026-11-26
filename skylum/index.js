// index.js — SKYLUM facade: OS services wired onto ITERON.
// Boot order: memory claims -> persistence -> seats -> doors -> infer -> mesh.
// Everything above ITERON; core invariants (formats, digests, reemit)
// stay in iteron/*.

import { VSpace } from "./memory.js";
import { persist } from "./persist.js";
import { Scheduler } from "./seats.js";
import { InferenceDoor } from "./infer.js";
import { MeshNode, meshSupported } from "./mesh.js";
import { createFabricClient } from "./fabric.js";
import { OpticalLink } from "./optical.js";
import { audioFskDoor } from "./audio.js";
import { solarState, lunarState, observerSky, altAz, gmst, STARS } from "./astro.js";
import { DoorBus, DOOR, downloadDoor, fileDoor, websocketDoor, webserialDoor, qrDisplayDoor } from "./doors.js";

export class Skylum {
  constructor(iteron, opts = {}) {
    this.iteron = iteron;
    this.memory = new VSpace(iteron);
    this.persist = opts.persist ?? persist;
    this.seats = new Scheduler(iteron);
    this.infer = new InferenceDoor(iteron, opts.infer ?? {});
    this.mesh = new MeshNode(iteron, opts.mesh ?? {});
    this.fabric = opts.fabric?.client ?? createFabricClient(opts.fabric ?? {});
    this.optical = new OpticalLink(iteron, opts.optical ?? {});
    // stateless celestial service (pure functions) — flat handle so the
    // import-stripped quine bundle resolves the same symbols.
    this.astro = { solarState, lunarState, observerSky, altAz, gmst, STARS };
    this.bus = new DoorBus(iteron);
    this._wireDoors(opts.doors ?? {});
    this.host = Object.freeze({
      runtime: opts.host?.runtime ?? "browser",
      capabilities: Object.freeze({ ...(opts.host?.capabilities ?? {}) }),
    });
  }

  _wireDoors(hooks = {}) {
    const doc = typeof document !== "undefined" ? document : null;
    if (hooks.download !== false && doc)
      this.bus.register(DOOR.download, "download", downloadDoor(doc));
    if (hooks.file && doc)
      this.bus.register(DOOR.file, "file", fileDoor(hooks.file));
    if (hooks.websocket)
      this.bus.register(DOOR.websocket, "websocket", websocketDoor(hooks.websocket));
    if (hooks.webserial !== false) {
      const sd = webserialDoor();
      this.bus.register(DOOR.webserial, "webserial", sd);
      if (!sd.supported) this.bus.doors.get(DOOR.webserial).enabled = false;
    }
    if (hooks.qrCanvas && doc)
      this.bus.register(DOOR.qrDisplay, "qr-display", qrDisplayDoor(hooks.qrCanvas));
    if (hooks.audio !== false) {
      const ad = audioFskDoor(hooks.audioOpts ?? {});
      if (ad.supported) this.bus.register(DOOR.audiofsk, "audio-fsk", ad);
    }
    if (hooks.mesh)
      this.bus.register(DOOR.mesh, "mesh", {
        send: async bytes => {
          const r = await this.mesh.broadcast(bytes);
          return { verdict: r.every(x => !x.error) ? 0 : 1 };
        },
      });
    if (Array.isArray(hooks.extra))
      for (const extra of hooks.extra) {
        if (!extra || !Number.isInteger(extra.id) || typeof extra.name !== "string" ||
            (typeof extra.adapter?.send !== "function" &&
             typeof extra.adapter?.recv !== "function"))
          throw new Error("door_extra_invalid");
        this.bus.register(extra.id, extra.name, extra.adapter);
      }
  }

  // hydrate OS state from ITERON's current .skcs volume
  async loadState() {
    const parsed = this.iteron.core.skcsParse(this.iteron.stateBlob);
    await this.memory.load(parsed);
    return parsed;
  }

  // persist: pack claims+staging into a new state volume, optionally OPFS
  async save(name = null) {
    const blob = await this.memory.save();
    if (name) await this.persist.saveVolume(name, blob);
    return blob;
  }

  // restore a named OPFS volume into ITERON + claims
  async restore(name = "state.skcs") {
    if (typeof this.persist.loadVolume === "function") {
      const bytes = await this.persist.loadVolume(name);
      if (!bytes) return false;
      const parsed = this.iteron.core.skcsParse(bytes);
      if (!parsed) throw new Error("state_volume_malformed");
      this.iteron.stateBlob = bytes;
      await this.memory.load(parsed);
      return true;
    }
    const ok = await this.persist.loadIteron(this.iteron, name);
    if (ok) await this.loadState();
    return ok;
  }

  // status snapshot for ECHO — read-only reflection of OS state.
  // Does NOT call seats.receipt() (that mutates the audit log).
  async status() {
    const claims = [...this.memory.claims.entries()].map(([name, c]) => ({
      name, base: "0x" + c.base.toString(16), size: c.size, perms: c.perms, dirty: c.dirty,
    }));
    const seatList = [...this.seats.seats.values()].map(s => ({
      id: s.id, steps: s.steps, fuel_left: Math.max(0, s.fuel), done: s.done,
    }));
    return {
      claims, seats: seatList,
      doors: [...this.bus.doors.values()].map(d => ({ id: d.id, name: d.name, enabled: d.enabled })),
      infer: { available: this.infer.available, endpoint: this.infer.endpoint },
      mesh: { supported: meshSupported(), peers: this.mesh.peers.size },
      fabric: { configured: Boolean(this.fabric), head: this.fabric?.baseUrl?.origin ?? null },
      persist: {
        opfs: persist.opfsSupported(),
        host: this.persist.available === true,
        available: this.persist.available === true || persist.opfsSupported(),
      },
      host: this.host,
      tick: this.seats.tickCount,
    };
  }
}
