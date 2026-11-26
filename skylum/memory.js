// memory.js — SKYLUM VSpace: claim/memory management over .skcs volumes.
// Claims are .skcs members; addresses are claim indices + offsets.
// The staging arena is a reserved member (__staging) — covo's 1 MiB
// staging boundary: external bytes land there before commit.
//
// Codec law: skcsParse yields STORED member bytes (possibly zlib); the
// VSpace normalizes every member to RAW data + codec "auto" on load so
// skcsPack always receives raw input — never double-compressed.

import { claimMember, claimMeta } from "./state.js";

export const STAGING_MEMBER = "__staging";
export const STAGING_SIZE = 1 << 20; // 1 MiB staging arena

const HEAP_BASE = 0x10000;

export class VSpace {
  constructor(iteron) {
    this.iteron = iteron;
    this.claims = new Map();   // name -> {member, base, size, perms, dirty}
    this.heapTop = HEAP_BASE;
    this.staging = null;       // normalized member record (raw data)
  }

  // hydrate from a parsed .skcs volume — ASYNC: inflates stored members
  async load(parsed) {
    this.claims.clear();
    this.heapTop = HEAP_BASE;
    this.staging = null;
    for (const m of parsed?.members ?? []) {
      const raw = await this.iteron.core.inflateMember(m);
      const meta = claimMeta(m);
      const member = claimMember(m.name, raw, {
        kind: m.kindName ?? m.kind, media: m.media, meta,
      });
      if (m.name === STAGING_MEMBER) {
        this.staging = member;
        continue;
      }
      const base = meta.base ? parseInt(meta.base) : this.heapTop;
      this.claims.set(m.name, {
        member, base, size: raw.length,
        perms: meta.perms || "rw", dirty: false,
      });
      this.heapTop = Math.max(this.heapTop, base + raw.length);
    }
    return this;
  }

  // ensure the staging arena member exists (created on first use)
  async ensureStaging() {
    if (this.staging) return this.staging;
    const data = new Uint8Array(STAGING_SIZE);
    this.staging = {
      name: STAGING_MEMBER, kind: "ramdump", codec: "auto",
      data, media: "arena",
      meta: JSON.stringify({ base: "0x0", size: STAGING_SIZE, perms: "rw", staging: true }),
      stagedLen: 0, dirty: false,
    };
    return this.staging;
  }

  // allocate a claim of `size` bytes; returns claim record
  async alloc(name, size, { kind = "file", perms = "rw", media = "" } = {}) {
    if (this.claims.has(name)) throw new Error(`claim ${name} exists`);
    const base = this.heapTop;
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(base + size))
      throw new Error("claim size invalid");
    const data = new Uint8Array(size);
    const meta = { base: "0x" + base.toString(16), size, perms };
    const member = claimMember(name, data, { kind, media, meta });
    const claim = { member, base, size, perms, dirty: true };
    this.claims.set(name, claim);
    this.heapTop = base + size;
    return claim;
  }

  get(name) { return this.claims.get(name) ?? null; }

  list() {
    return [...this.claims.entries()].map(([name, claim]) => ({
      name, base: claim.base, size: claim.size, perms: claim.perms,
      dirty: claim.dirty, kind: claim.member.kind, media: claim.member.media,
      meta: claim.member.meta,
    }));
  }

  free(name) {
    const claim = this.claims.get(name);
    if (!claim) return false;
    this.claims.delete(name);
    if (claim.base + claim.size === this.heapTop) {
      this.heapTop = Math.max(HEAP_BASE, ...[...this.claims.values()].map(c => c.base + c.size));
    }
    return true;
  }

  upsertMember(name, data, { kind = "file", media = "", meta = {} } = {}) {
    if (typeof name !== "string" || !name || name === STAGING_MEMBER ||
        !(data instanceof Uint8Array))
      throw new Error("claim_member_invalid");
    const existing = this.claims.get(name);
    if (existing) {
      if (!existing.perms.includes("w")) throw new Error(`claim ${name} is ${existing.perms}`);
      const member = claimMember(name, data, { kind, media, meta });
      existing.member = member;
      existing.size = data.length;
      existing.dirty = true;
      return existing;
    }
    const base = this.heapTop;
    if (!Number.isSafeInteger(base + data.length)) throw new Error("claim size invalid");
    const member = claimMember(name, data, { kind, media, meta: {
      base: `0x${base.toString(16)}`, size: data.length, perms: "rw", ...meta,
    } });
    const claim = { member, base, size: data.length, perms: "rw", dirty: true };
    this.claims.set(name, claim);
    this.heapTop = base + data.length;
    return claim;
  }

  // read region -> bytes (member data is always raw post-normalize)
  async read(name, off = 0, len = null) {
    const c = this.claims.get(name);
    if (!c) throw new Error(`no claim ${name}`);
    if (!Number.isSafeInteger(off) || off < 0 ||
        (len !== null && (!Number.isSafeInteger(len) || len < 0)))
      throw new Error("read range invalid");
    return c.member.data.slice(off, len == null ? undefined : off + len);
  }

  // write into a claim (marks dirty; persists on commit)
  async write(name, bytes, off = 0) {
    const c = this.claims.get(name);
    if (!c) throw new Error(`no claim ${name}`);
    if (!c.perms.includes("w")) throw new Error(`claim ${name} is ${c.perms}`);
    if (!Number.isSafeInteger(off) || off < 0 || !(bytes instanceof Uint8Array))
      throw new Error("write range invalid");
    if (off + bytes.length > c.member.data.length) throw new Error("write exceeds claim");
    c.member.data.set(bytes, off);
    c.dirty = true;
    return c;
  }

  // staging write: external bytes land in the arena before commit.
  // stagedLen tracks the high-water mark so commit() emits only real data.
  async stage(bytes, off = 0) {
    const s = await this.ensureStaging();
    const view = s.data instanceof Uint8Array ? s.data : new Uint8Array(s.data);
    if (!Number.isSafeInteger(off) || off < 0 || !(bytes instanceof Uint8Array))
      throw new Error("staging range invalid");
    if (off + bytes.length > view.length) throw new Error("staging overflow");
    view.set(bytes, off);
    s.stagedLen = Math.max(s.stagedLen ?? 0, off + bytes.length);
    s.dirty = true;
    return s;
  }

  // commit staged bytes -> named claim (arena consumed, reusable after)
  async commit(name, { kind = "file", media = "" } = {}) {
    const s = await this.ensureStaging();
    const len = s.stagedLen ?? s.data.length;
    const bytes = s.data.slice(0, len);
    const claim = await this.alloc(name, bytes.length, { kind, media });
    claim.member.data = bytes;
    claim.dirty = true;
    s.stagedLen = 0;
    s.dirty = false;
    return claim;
  }

  // seal: sha256 over a claim's raw bytes via ITERON
  async seal(name) {
    const c = this.claims.get(name);
    if (!c) throw new Error(`no claim ${name}`);
    return this.iteron.core.sha256(c.member.data);
  }

  // members for iteron.commit() — includes staging arena when present
  members() {
    const out = [...this.claims.values()].map(c => c.member);
    if (this.staging) out.push(this.staging);
    return out;
  }

  // persist whole space as new .skcs volume
  async save(flags = 0) {
    return this.iteron.commit(this.members(), flags);
  }
}
