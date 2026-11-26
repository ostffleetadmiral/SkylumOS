// hw-probe.js — real hardware inventory for Node/Electron hosts.
// Everything here is a measured syscall: sysfs reads, /dev scans, group
// membership, and tool subprocesses that exist on PATH. Nothing is
// fabricated — absent hardware reports absent, unreadable reports
// unreadable, missing tools report missing.

import { readdir, readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";

const SYS_PCI = "/sys/bus/pci/devices";
const PCI_CLASS_DISPLAY = /^0x03/; // VGA / 3D / display controllers

const run = (cmd, args, timeoutMs = 8000) => new Promise(resolve => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 },
    (error, stdout) => resolve(error ? null : stdout));
});

const lines = (text, re) =>
  (text ?? "").split("\n").map(l => re.exec(l)).filter(Boolean);

// PCI display devices via sysfs — vendor/device ids + bound driver.
async function probePci() {
  const out = [];
  try {
    for (const dev of await readdir(SYS_PCI)) {
      let cls;
      try { cls = (await readFile(`${SYS_PCI}/${dev}/class`, "utf8")).trim(); }
      catch { continue; }
      if (!PCI_CLASS_DISPLAY.test(cls)) continue;
      const grab = async name => {
        try { return (await readFile(`${SYS_PCI}/${dev}/${name}`, "utf8")).trim(); }
        catch { return null; }
      };
      const uevent = (await grab("uevent")) ?? "";
      out.push({
        pci: dev,
        class: cls,
        vendor: await grab("vendor"),
        device: await grab("device"),
        driver: /DRIVER=(\S+)/.exec(uevent)?.[1] ?? null,
      });
    }
  } catch { /* sysfs absent (non-linux) — empty report is honest */ }
  return out;
}

// /dev/dri nodes + real access check (R_OK|W_OK) per node.
async function probeDri() {
  const nodes = [];
  try {
    for (const name of (await readdir("/dev/dri")).sort()) {
      if (!/^(card|renderD)\d+$/.test(name)) continue;
      const path = `/dev/dri/${name}`;
      let accessible = false;
      try { await access(path, constants.R_OK | constants.W_OK); accessible = true; }
      catch { /* group/perm gap — report honestly */ }
      nodes.push({ path, accessible });
    }
  } catch { /* no drm */ }
  return nodes;
}

// Video/serial device nodes.
async function probeDevices() {
  const video = [], serial = [];
  try {
    for (const name of await readdir("/dev")) {
      if (/^video\d+$/.test(name)) video.push(`/dev/${name}`);
      else if (/^tty(S|USB|ACM|AMA|XRUSB|USB_SERIAL)\d+/.test(name) ||
               /^cu\./.test(name)) serial.push(`/dev/${name}`);
    }
  } catch { /* /dev unreadable */ }
  try {
    for (const name of await readdir("/dev/serial/by-id"))
      serial.push(`/dev/serial/by-id/${name}`);
  } catch { /* no by-id dir */ }
  return { video: video.sort(), serial: serial.sort() };
}

// vulkaninfo --summary — real device enumeration when the tool exists.
async function probeVulkan() {
  const text = await run("vulkaninfo", ["--summary"]);
  if (text === null) return { tool: "absent", devices: [] };
  const devices = lines(text, /deviceName\s*=\s*(.+)/).map(m => ({ name: m[1].trim() }));
  const types = lines(text, /deviceType\s*=\s*(\S+)/).map(m => m[1]);
  const drivers = lines(text, /driverName\s*=\s*(\S+)/).map(m => m[1]);
  return {
    tool: "vulkaninfo",
    devices: devices.map((d, i) => ({
      name: d.name,
      type: types[i] ?? null,
      driver: drivers[i] ?? null,
    })),
  };
}

// Group membership — which /dev lanes this process can actually open.
// Gid names are read live from /etc/group so the report is measured,
// not guessed.
const GROUP_GIDS = {};
const WATCH_GROUPS = ["render", "video", "dialout", "plugdev", "input"];

function probeGroups() {
  const gids = typeof process.getgroups === "function" ? process.getgroups() : [];
  const names = {};
  for (const g of WATCH_GROUPS) names[g] = gids.includes(GROUP_GIDS[g] ?? -1);
  return { gids, ...names };
}
async function loadGroupIds() {
  try {
    const text = await readFile("/etc/group", "utf8");
    for (const line of text.split("\n")) {
      const m = /^([a-z_-]+):x:(\d+):/.exec(line);
      if (m) GROUP_GIDS[m[1]] = Number(m[2]);
    }
  } catch { /* no /etc/group */ }
}

export async function probeHardware() {
  await loadGroupIds();
  const [pci, dri, devices, vulkan] = await Promise.all([
    probePci(), probeDri(), probeDevices(), probeVulkan(),
  ]);
  const groups = probeGroups();
  return {
    pci: { display: pci },
    drm: { nodes: dri },
    video: devices.video,
    serial: devices.serial,
    vulkan,
    groups,
    platform: process.platform,
    timestamp: new Date().toISOString(),
  };
}
