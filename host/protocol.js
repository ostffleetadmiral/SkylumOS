import { timingSafeEqual } from "node:crypto";
import { createHostApi, decodePayload, validateClaimName, validateLimit, validateVolumeName } from "./runtime.js";

export const HOST_PROTOCOL_VERSION = 1;
export const HOST_COMMANDS = Object.freeze([
  "status", "claims.list", "claims.read", "volumes.list", "volumes.load",
  "volumes.save", "volumes.delete", "infer.complete", "doors.send", "doors.recv",
  "hw.probe", "quine.reemit",
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
        default: throw new Error("host_command_denied");
      }
    },
  });
}

export function authorizeToken(expected, actual) {
  if (typeof expected !== "string" || typeof actual !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}
