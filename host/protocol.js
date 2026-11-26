import { timingSafeEqual } from "node:crypto";
import { createHostApi, decodePayload, validateClaimName, validateLimit, validateVolumeName } from "./runtime.js";

export const HOST_PROTOCOL_VERSION = 1;
export const HOST_COMMANDS = Object.freeze([
  "status", "claims.list", "claims.read", "volumes.list", "volumes.load",
  "volumes.save", "volumes.delete", "infer.complete", "doors.send", "doors.recv",
  "hw.probe", "quine.reemit",
  "term.spawn", "term.write", "term.read", "term.resize", "term.kill", "term.list",
]);
export const MAX_REQUEST_BYTES = 1 << 20;

export function createHostProtocol(runtime) {
  const api = createHostApi(runtime);
  return Object.freeze({
    async dispatch(command, args = {}) {
      if (!HOST_COMMANDS.includes(command)) throw new Error("host_command_denied");
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("host_args_invalid");
      switch (command) {
        case "status": return api.status();
        case "claims.list": return api.listClaims();
        case "claims.read": return api.readClaim(validateClaimName(args.name),
          args.maxBytes === undefined ? 1 << 20 : validateLimit(args.maxBytes, "claim_limit", 1 << 20));
        case "volumes.list": return api.listVolumes();
        case "volumes.load": return api.loadVolume(validateVolumeName(args.name ?? "state.skcs"));
        case "volumes.save": return api.saveVolume(validateVolumeName(args.name ?? "state.skcs"));
        case "volumes.delete": {
          const name = validateVolumeName(args.name);
          const deleted = await runtime.skylum.persist.deleteVolume(name);
          return { name, deleted: deleted !== false };
        }
        case "infer.complete": return api.infer(args.prompt);
        case "doors.send": {
          const id = args.id;
          const bytes = decodePayload(args.payload, 1 << 20);
          return api.sendDoor(id, Buffer.from(bytes).toString("base64"));
        }
        case "doors.recv":
          return api.recvDoor(args.id,
            args.maxBytes === undefined ? 1 << 20
              : validateLimit(args.maxBytes, "door_recv_limit", 1 << 20));
        case "hw.probe": return api.hwProbe();
        case "quine.reemit": return api.reemit();
        case "term.spawn": return termService(runtime).spawn(termSpawnArgs(args));
        case "term.write": return termService(runtime).write(termId(args), termData(args));
        case "term.read": return termService(runtime).read(termId(args),
          { maxBytes: args.maxBytes === undefined ? undefined : validateLimit(args.maxBytes, "term_read_limit", 1 << 20) });
        case "term.resize": return termService(runtime).resize(termId(args), termSize(args));
        case "term.kill": return termService(runtime).kill(termId(args));
        case "term.list": return termService(runtime).list();
        default: throw new Error("host_command_denied");
      }
    },
  });
}

function termService(runtime) {
  if (!runtime.term || typeof runtime.term.spawn !== "function")
    throw new Error("term_service_unavailable");
  return runtime.term;
}

function termId(args) {
  if (typeof args.id !== "string" || args.id.length === 0 || args.id.length > 128)
    throw new Error("host_args_invalid");
  return args.id;
}

function termData(args) {
  if (typeof args.data !== "string" || args.data.length === 0)
    throw new Error("host_args_invalid");
  return args.data;
}

function termSpawnArgs(args) {
  const out = {};
  if (args.cols !== undefined) {
    if (!Number.isInteger(args.cols)) throw new Error("host_args_invalid");
    out.cols = args.cols;
  }
  if (args.rows !== undefined) {
    if (!Number.isInteger(args.rows)) throw new Error("host_args_invalid");
    out.rows = args.rows;
  }
  if (args.cwd !== undefined) {
    if (typeof args.cwd !== "string" || args.cwd.length > 4096)
      throw new Error("host_args_invalid");
    out.cwd = args.cwd;
  }
  return out;
}

function termSize(args) {
  const out = {};
  if (args.cols !== undefined) {
    if (!Number.isInteger(args.cols)) throw new Error("host_args_invalid");
    out.cols = args.cols;
  }
  if (args.rows !== undefined) {
    if (!Number.isInteger(args.rows)) throw new Error("host_args_invalid");
    out.rows = args.rows;
  }
  return out;
}

export function authorizeToken(expected, actual) {
  if (typeof expected !== "string" || typeof actual !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}
