// threecast — MIT License
// An in-memory Hetzner Cloud API (the endpoints threecast calls), built from the shapes in the
// official OpenAPI spec. Request bodies are checked against the spec's allowed and required
// fields, so a typo in lib/ fails here instead of against the real API.
import http from "node:http";
import { createHash } from "node:crypto";

const LOCATIONS = ["fsn1", "nbg1", "hel1", "ash", "hil", "sin"];

const DEFAULT_TYPES = [
  { name: "cpx42", cores: 8, memory: 16, architecture: "x86", onSale: ["fsn1", "nbg1", "hel1", "sin"],
    deprecatedIn: ["sin"], hourly: "0.1114000000000000", monthly: "69.4900000000000000" },
  { name: "ccx23", cores: 4, memory: 16, architecture: "x86", onSale: ["fsn1", "nbg1", "hel1", "ash", "hil"],
    deprecatedIn: [], hourly: "0.1378000000000000", monthly: "85.9900000000000000" },
  { name: "cax31", cores: 8, memory: 16, architecture: "arm", onSale: [],
    deprecatedIn: [], hourly: "0.0336000000000000", monthly: "20.9900000000000000" },
  { name: "cx43", cores: 8, memory: 16, architecture: "x86", onSale: [],
    deprecatedIn: [], hourly: "0.0256000000000000", monthly: "15.9900000000000000" },
];

const SPEC = {
  ssh_keys: { required: ["name", "public_key"], allowed: ["name", "public_key", "labels"] },
  firewalls: { required: ["name"], allowed: ["name", "labels", "rules", "apply_to"] },
  volumes: { required: ["size", "name"], allowed: ["size", "name", "labels", "automount", "format", "location", "server"] },
  servers: {
    required: ["name", "server_type", "image"],
    allowed: ["name", "location", "server_type", "start_after_create", "image", "placement_group", "ssh_keys",
      "volumes", "networks", "firewalls", "user_data", "labels", "automount", "public_net"],
  },
  primary_ip_update: { required: [], allowed: ["name", "labels", "auto_delete"] },
};

const LABEL_VALUE = /^([a-zA-Z0-9]([a-zA-Z0-9_.-]{0,61}[a-zA-Z0-9])?)?$/;

export function md5Fingerprint(publicKey) {
  const blob = Buffer.from(publicKey.trim().split(/\s+/)[1], "base64");
  return createHash("md5").update(blob).digest("hex").match(/../g).join(":");
}

function checkBody(kind, body) {
  if (body === null || typeof body !== "object") return "body must be a JSON object";
  const spec = SPEC[kind];
  for (const key of Object.keys(body)) if (!spec.allowed.includes(key)) return `unknown field '${key}'`;
  for (const key of spec.required) if (body[key] === undefined) return `missing required field '${key}'`;
  for (const [k, v] of Object.entries(body.labels ?? {})) {
    if (typeof v !== "string" || !LABEL_VALUE.test(v)) return `invalid label value for '${k}'`;
  }
  return null;
}

// Hetzner's label selector, reduced to the k=v / k==v form threecast uses.
function selects(labels, selector) {
  if (!selector) return true;
  const [k, v] = selector.split(/==?/);
  return labels?.[k] === v;
}

export async function startHetzner(options = {}) {
  const opts = {
    token: "test-hcloud-token",
    types: DEFAULT_TYPES,
    soldOut: [],               // "type@location" pairs whose POST /servers answers 412
    volumeLimit: false,        // POST /volumes answers 403 resource_limit_exceeded
    serverForbidden: false,    // POST /servers answers 403 forbidden
    serverLimit: false,        // POST /servers answers 403 resource_limit_exceeded
    serverActionError: false,  // the create_server action ends in "error"
    serverHangs: false,        // the create_server action never finishes
    firewallBusyOnce: false,   // the first DELETE /firewalls answers 422 resource_in_use
    volumeReplyLost: false,    // POST /volumes creates the volume but never answers
    serverReplyLost: false,    // POST /servers creates the server and its IPs but never answers
    ...options,
  };
  const state = {
    nextId: 100, requests: [], deleted: [],
    servers: new Map(), volumes: new Map(), firewalls: new Map(), sshKeys: new Map(),
    primaryIps: new Map(), actions: new Map(),
  };
  const id = () => ++state.nextId;
  let firewallBusy = opts.firewallBusyOnce;

  function action(command, resources, onSuccess, outcome = "success") {
    const a = { id: id(), command, status: "running", progress: 0, started: new Date().toISOString(),
      finished: null, resources, error: null, onSuccess, outcome };
    state.actions.set(a.id, a);
    return a;
  }
  const actionJson = ({ onSuccess, outcome, ...a }) => a;

  function addPrimaryIp(type, serverId, location, labels = {}) {
    const n = state.primaryIps.size + 7;
    const ip = { id: id(), name: `primary_ip-${n}`, labels, created: new Date().toISOString(), blocked: false,
      location: { name: location }, ip: type === "ipv4" ? `203.0.113.${n}` : `2001:db8:${n}::/64`, dns_ptr: [],
      protection: { delete: false }, type, auto_delete: false,
      assignee_type: serverId ? "server" : "unassigned", assignee_id: serverId };
    state.primaryIps.set(ip.id, ip);
    return ip;
  }

  function serverJson(s) {
    const v4 = state.primaryIps.get(s.ipv4), v6 = state.primaryIps.get(s.ipv6);
    const t = opts.types.find((x) => x.name === s.server_type);
    return {
      id: s.id, name: s.name, status: s.status, created: s.created, labels: s.labels,
      public_net: {
        ipv4: v4 ? { id: v4.id, ip: v4.ip, blocked: false, dns_ptr: "static.example" } : null,
        ipv6: v6 ? { id: v6.id, ip: v6.ip, blocked: false, dns_ptr: [] } : null,
        floating_ips: [], firewalls: s.firewalls.map((f) => ({ id: f, status: "applied" })),
      },
      server_type: { name: t.name, cores: t.cores, memory: t.memory, architecture: t.architecture },
      location: { name: s.location }, volumes: s.volumes, image: { name: s.image },
    };
  }

  function deleteServer(s) {
    state.servers.delete(s.id);
    state.deleted.push(`server:${s.id}`);
    for (const v of state.volumes.values()) if (v.server === s.id) v.server = null;
    for (const ip of state.primaryIps.values()) {
      if (ip.assignee_id !== s.id) continue;
      if (ip.auto_delete) { state.primaryIps.delete(ip.id); state.deleted.push(`primary_ip:${ip.id}`); }
      else { ip.assignee_id = null; ip.assignee_type = "unassigned"; }
    }
  }

  const routes = [
    ["GET", /^\/server_types$/, (q) => {
      const list = opts.types.filter((t) => !q.name || t.name === q.name).map((t, i) => ({
        id: i + 1, name: t.name, description: t.name.toUpperCase(), cores: t.cores, memory: t.memory, disk: 160,
        deprecated: false, deprecation: null, storage_type: "local", cpu_type: "shared", architecture: t.architecture,
        prices: [], locations: LOCATIONS.map((l, j) => ({
          id: j + 1, name: l, recommended: false, available: t.onSale.includes(l),
          deprecation: t.deprecatedIn.includes(l) ? { announced: "2026-09-01T00:00:00Z", unavailable_after: "2026-12-01T00:00:00Z" } : null,
        })),
      }));
      return [200, { server_types: list, meta: { pagination: { page: 1, per_page: 50, total_entries: list.length } } }];
    }],
    ["GET", /^\/pricing$/, () => [200, { pricing: {
      currency: "EUR", vat_rate: "19.00",
      primary_ips: [
        { type: "ipv4", prices: LOCATIONS.map((l) => ({ location: l, price_hourly: { net: "0.0008000000", gross: "0.0009520000" }, price_monthly: { net: "0.5000000000", gross: "0.5950000000" } })) },
        { type: "ipv6", prices: LOCATIONS.map((l) => ({ location: l, price_hourly: { net: "0.0000000000", gross: "0.0000000000" }, price_monthly: { net: "0.0000000000", gross: "0.0000000000" } })) },
      ],
      volume: { price_per_gb_month: { net: "0.0572000000", gross: "0.0680680000" } },
      server_types: opts.types.map((t, i) => ({ id: i + 1, name: t.name, prices: LOCATIONS.map((l) => ({
        location: l, price_hourly: { net: t.hourly, gross: t.hourly }, price_monthly: { net: t.monthly, gross: t.monthly },
        included_traffic: 21990232555520, price_per_tb_traffic: { net: "1.0000000000", gross: "1.1900000000" } })) })),
    } }]],

    ["GET", /^\/ssh_keys$/, (q) => [200, { ssh_keys: [...state.sshKeys.values()].filter((k) =>
      (!q.fingerprint || k.fingerprint === q.fingerprint) && selects(k.labels, q.label_selector)) }]],
    ["POST", /^\/ssh_keys$/, (q, body) => {
      const bad = checkBody("ssh_keys", body);
      if (bad) return [422, "invalid_input", bad];
      const fingerprint = md5Fingerprint(body.public_key);
      for (const k of state.sshKeys.values()) {
        if (k.fingerprint === fingerprint) return [409, "uniqueness_error", "SSH key with the same fingerprint already exists"];
        if (k.name === body.name) return [409, "uniqueness_error", "SSH key with the same name already exists"];
      }
      const key = { id: id(), name: body.name, fingerprint, public_key: body.public_key, labels: body.labels ?? {}, created: new Date().toISOString() };
      state.sshKeys.set(key.id, key);
      return [201, { ssh_key: key }];
    }],
    ["DELETE", /^\/ssh_keys\/(\d+)$/, (q, body, [kid]) => {
      if (!state.sshKeys.delete(kid)) return [404, "not_found", "ssh key not found"];
      state.deleted.push(`ssh_key:${kid}`);
      return [204];
    }],

    ["GET", /^\/firewalls$/, (q) => [200, { firewalls: [...state.firewalls.values()].filter((f) => selects(f.labels, q.label_selector)) }]],
    ["POST", /^\/firewalls$/, (q, body) => {
      const bad = checkBody("firewalls", body);
      if (bad) return [422, "invalid_input", bad];
      for (const r of body.rules ?? []) {
        if (!["in", "out"].includes(r.direction) || !["tcp", "udp", "icmp", "esp", "gre"].includes(r.protocol)) {
          return [422, "invalid_input", "invalid rule"];
        }
        if (["tcp", "udp"].includes(r.protocol) && typeof r.port !== "string") return [422, "invalid_input", "port must be a string"];
      }
      if ([...state.firewalls.values()].some((f) => f.name === body.name)) return [409, "uniqueness_error", "name is already used"];
      const fw = { id: id(), name: body.name, labels: body.labels ?? {}, rules: body.rules ?? [], applied_to: [], created: new Date().toISOString() };
      state.firewalls.set(fw.id, fw);
      return [201, { firewall: fw, actions: [] }];
    }],
    ["DELETE", /^\/firewalls\/(\d+)$/, (q, body, [fid]) => {
      if (!state.firewalls.has(fid)) return [404, "not_found", "firewall not found"];
      const inUse = [...state.servers.values()].some((s) => s.firewalls.includes(fid));
      if (inUse || firewallBusy) { firewallBusy = false; return [422, "resource_in_use", "Firewall still applied to a resource"]; }
      state.firewalls.delete(fid);
      state.deleted.push(`firewall:${fid}`);
      return [204];
    }],

    ["GET", /^\/volumes$/, (q) => [200, { volumes: [...state.volumes.values()].filter((v) => selects(v.labels, q.label_selector)) }]],
    ["GET", /^\/volumes\/(\d+)$/, (q, body, [vid]) => state.volumes.has(vid) ? [200, { volume: state.volumes.get(vid) }] : [404, "not_found", "volume not found"]],
    ["POST", /^\/volumes$/, (q, body) => {
      const bad = checkBody("volumes", body);
      if (bad) return [422, "invalid_input", bad];
      if (body.automount && body.server === undefined) return [422, "invalid_input", "automount requires server"];
      if (body.format && !["xfs", "ext4"].includes(body.format)) return [422, "invalid_input", "invalid format"];
      if (opts.volumeLimit) return [403, "resource_limit_exceeded", "volume size limit exceeded"];
      if ([...state.volumes.values()].some((v) => v.name === body.name)) return [409, "uniqueness_error", "name is already used"];
      const vid = id();
      const vol = { id: vid, name: body.name, size: body.size, server: null, location: { name: body.location },
        linux_device: `/dev/disk/by-id/scsi-0HC_Volume_${vid}`, protection: { delete: false },
        labels: body.labels ?? {}, status: "creating", format: body.format ?? null, created: new Date().toISOString() };
      state.volumes.set(vid, vol);
      const a = action("create_volume", [{ id: vid, type: "volume" }], () => { vol.status = "available"; });
      if (opts.volumeReplyLost) return null;
      return [201, { volume: vol, action: actionJson(a), next_actions: [] }];
    }],
    ["POST", /^\/volumes\/(\d+)\/actions\/detach$/, (q, body, [vid]) => {
      const vol = state.volumes.get(vid);
      if (!vol) return [404, "not_found", "volume not found"];
      const a = action("detach_volume", [{ id: vid, type: "volume" }], () => { vol.server = null; });
      return [201, { action: actionJson(a) }];
    }],
    ["DELETE", /^\/volumes\/(\d+)$/, (q, body, [vid]) => {
      const vol = state.volumes.get(vid);
      if (!vol) return [404, "not_found", "volume not found"];
      if (vol.server !== null) return [423, "locked", "volume is attached to a server"];
      state.volumes.delete(vid);
      state.deleted.push(`volume:${vid}`);
      return [204];
    }],

    ["GET", /^\/servers$/, (q) => [200, { servers: [...state.servers.values()].filter((s) => selects(s.labels, q.label_selector)).map(serverJson) }]],
    ["GET", /^\/servers\/(\d+)$/, (q, body, [sid]) => state.servers.has(sid) ? [200, { server: serverJson(state.servers.get(sid)) }] : [404, "not_found", "server not found"]],
    ["POST", /^\/servers$/, (q, body) => {
      const bad = checkBody("servers", body);
      if (bad) return [422, "invalid_input", bad];
      if (opts.serverForbidden) return [403, "forbidden", "insufficient permissions"];
      if (opts.serverLimit) return [403, "resource_limit_exceeded", "server limit exceeded"];
      const type = opts.types.find((t) => t.name === body.server_type);
      if (!type) return [422, "invalid_input", "unknown server type"];
      if (opts.soldOut.includes(`${body.server_type}@${body.location}`) || !type.onSale.includes(body.location)) {
        return [412, "resource_unavailable", "error during placement (resource_unavailable)"];
      }
      if (typeof body.user_data !== "string" || Buffer.byteLength(body.user_data) > 32 * 1024) return [422, "invalid_input", "user_data"];
      for (const k of body.ssh_keys ?? []) if (!state.sshKeys.has(k)) return [422, "invalid_input", `unknown ssh key ${k}`];
      for (const f of body.firewalls ?? []) {
        if (Object.keys(f).join() !== "firewall" || !state.firewalls.has(f.firewall)) return [422, "invalid_input", "firewalls"];
      }
      for (const v of body.volumes ?? []) {
        const vol = state.volumes.get(v);
        if (!vol || vol.location.name !== body.location || vol.server !== null) return [422, "invalid_input", `volume ${v}`];
      }
      if ([...state.servers.values()].some((s) => s.name === body.name)) return [409, "uniqueness_error", "server name is already used"];
      const sid = id();
      const s = { id: sid, name: body.name, status: "initializing", created: new Date().toISOString(), labels: body.labels ?? {},
        server_type: body.server_type, location: body.location, image: body.image, firewalls: (body.firewalls ?? []).map((f) => f.firewall),
        volumes: body.volumes ?? [], user_data: body.user_data };
      s.ipv4 = addPrimaryIp("ipv4", sid, body.location).id;
      s.ipv6 = addPrimaryIp("ipv6", sid, body.location).id;
      for (const v of s.volumes) state.volumes.get(v).server = sid;
      state.servers.set(sid, s);
      const outcome = opts.serverActionError ? "error" : opts.serverHangs ? "hang" : "success";
      const create = action("create_server", [{ id: sid, type: "server" }], () => {}, outcome);
      const start = action("start_server", [{ id: sid, type: "server" }], () => { s.status = "running"; });
      if (opts.serverReplyLost) return null;
      return [201, { server: serverJson(s), action: actionJson(create), next_actions: [actionJson(start)], root_password: null }];
    }],
    ["DELETE", /^\/servers\/(\d+)$/, (q, body, [sid]) => {
      const s = state.servers.get(sid);
      if (!s) return [404, "not_found", "server not found"];
      s.status = "deleting";
      const a = action("delete_server", [{ id: sid, type: "server" }], () => deleteServer(s));
      return [200, { action: actionJson(a) }];
    }],

    ["GET", /^\/primary_ips$/, (q) => [200, { primary_ips: [...state.primaryIps.values()].filter((p) => selects(p.labels, q.label_selector)) }]],
    ["GET", /^\/primary_ips\/(\d+)$/, (q, body, [pid]) => state.primaryIps.has(pid) ? [200, { primary_ip: state.primaryIps.get(pid) }] : [404, "not_found", "primary ip not found"]],
    ["PUT", /^\/primary_ips\/(\d+)$/, (q, body, [pid]) => {
      const ip = state.primaryIps.get(pid);
      if (!ip) return [404, "not_found", "primary ip not found"];
      const bad = checkBody("primary_ip_update", body);
      if (bad) return [422, "invalid_input", bad];
      Object.assign(ip, body);
      return [200, { primary_ip: ip }];
    }],
    ["DELETE", /^\/primary_ips\/(\d+)$/, (q, body, [pid]) => {
      const ip = state.primaryIps.get(pid);
      if (!ip) return [404, "not_found", "primary ip not found"];
      if (ip.assignee_id !== null) return [422, "must_be_unassigned", "Primary IP must be unassigned"];
      state.primaryIps.delete(pid);
      state.deleted.push(`primary_ip:${pid}`);
      return [204];
    }],

    ["GET", /^\/actions\/(\d+)$/, (q, body, [aid]) => {
      const a = state.actions.get(aid);
      if (!a) return [404, "not_found", "action not found"];
      if (a.status === "running" && a.outcome !== "hang") {
        if (a.outcome === "error") {
          a.status = "error";
          a.error = { code: "action_failed", message: "server creation failed" };
        } else {
          a.status = "success";
          a.onSuccess();
        }
        a.progress = 100;
        a.finished = new Date().toISOString();
      }
      return [200, { action: actionJson(a) }];
    }],
  ];

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const url = new URL(req.url, "http://mock");
      const path = url.pathname.replace(/^\/v1/, "");
      const query = Object.fromEntries(url.searchParams);
      let body = null;
      if (raw) {
        try { body = JSON.parse(raw); } catch { return send(res, 400, "json_error", "invalid JSON"); }
      }
      state.requests.push({ method: req.method, path, query, body, auth: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${opts.token}`) return send(res, 401, "unauthorized", "unable to authenticate");
      for (const [method, pattern, handler] of routes) {
        const m = req.method === method && path.match(pattern);
        if (!m) continue;
        const reply = handler(query, body, m.slice(1).map(Number));
        return reply && send(res, ...reply);
      }
      send(res, 404, "not_found", `no route ${req.method} ${path}`);
    });
  });

  function send(res, status, codeOrBody, message) {
    if (status === 204) { res.writeHead(204); return res.end(); }
    const body = typeof codeOrBody === "string" ? { error: { code: codeOrBody, message, details: null } } : codeOrBody;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    token: opts.token,
    state,
    billable: () => state.servers.size + state.volumes.size + state.primaryIps.size,
    addPrimaryIp,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}
