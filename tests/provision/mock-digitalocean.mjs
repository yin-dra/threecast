// threecast — MIT License
// An in-memory DigitalOcean API v2 (the endpoints threecast calls), shaped after the public
// OpenAPI spec. Request bodies are checked against the spec's allowed and required fields.
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

const SPEC = {
  keys: { required: ["name", "public_key"], allowed: ["name", "public_key"] },
  volumes: { required: ["name", "size_gigabytes", "region"],
    allowed: ["name", "size_gigabytes", "region", "description", "snapshot_id", "filesystem_type", "filesystem_label", "tags"] },
  droplets: { required: ["name", "size", "image"],
    allowed: ["name", "region", "size", "image", "ssh_keys", "backups", "backup_policy", "ipv6", "monitoring", "tags",
      "user_data", "private_networking", "volumes", "vpc_uuid", "subnet_uuid", "with_droplet_agent", "public_networking"] },
  firewalls: { required: ["name"], allowed: ["name", "inbound_rules", "outbound_rules", "droplet_ids", "tags"] },
  volume_action: { required: ["type"], allowed: ["type", "droplet_id", "region", "size_gigabytes", "tags"] },
};

function checkBody(kind, body) {
  if (body === null || typeof body !== "object") return "body must be a JSON object";
  for (const key of Object.keys(body)) if (!SPEC[kind].allowed.includes(key)) return `unknown field '${key}'`;
  for (const key of SPEC[kind].required) if (body[key] === undefined) return `missing required field '${key}'`;
  return null;
}

function checkRules(rules, side) {
  for (const r of rules ?? []) {
    if (!["tcp", "udp", "icmp"].includes(r.protocol) || typeof r.ports !== "string") return "invalid rule";
    if (!r[side] || !Array.isArray(r[side].addresses)) return `rule needs ${side}.addresses`;
  }
  return null;
}

export async function startDigitalOcean(options = {}) {
  const opts = {
    token: "test-do-token",
    firewallFails: false,   // POST /v2/firewalls answers 422 (after the volume and Droplet exist)
    volumeTierLimit: false, // POST /v2/volumes answers 422 with a limit message
    ...options,
  };
  const state = {
    nextId: 5000, requests: [], deleted: [],
    keys: new Map(), volumes: new Map(), droplets: new Map(), firewalls: new Map(), actions: new Map(),
  };
  const id = () => ++state.nextId;

  function action(type, resourceId, onDone) {
    const a = { id: id(), status: "in-progress", type, resource_id: resourceId, resource_type: "droplet",
      started_at: new Date().toISOString(), completed_at: null, region_slug: "fra1", onDone };
    state.actions.set(a.id, a);
    return a;
  }
  const actionJson = ({ onDone, ...a }) => a;

  const routes = [
    ["GET", /^\/v2\/account$/, () => [200, { account: { droplet_limit: 25, floating_ip_limit: 3, email: "test@example.com",
      uuid: "u", email_verified: true, status: "active", status_message: "" } }]],
    ["GET", /^\/v2\/sizes$/, () => [200, { sizes: [
      { slug: "s-4vcpu-8gb", memory: 8192, vcpus: 4, disk: 160, transfer: 5, price_monthly: 48, price_hourly: 0.07143,
        regions: ["fra1", "ams3", "nyc3"], available: true, description: "Basic" },
      { slug: "s-8vcpu-16gb", memory: 16384, vcpus: 8, disk: 320, transfer: 6, price_monthly: 96, price_hourly: 0.14286,
        regions: ["ams3", "fra1", "lon1", "nyc3", "sfo3", "sgp1"], available: true, description: "Basic" },
    ], links: {}, meta: { total: 2 } }]],
    ["GET", /^\/v2\/regions$/, () => [200, { regions: [
      { slug: "nyc1", name: "New York 1", available: false, features: [], sizes: [] },
      { slug: "fra1", name: "Frankfurt 1", available: true, features: ["backups", "ipv6", "metadata", "storage"], sizes: [] },
      { slug: "ams3", name: "Amsterdam 3", available: true, features: ["backups", "ipv6", "metadata", "storage"], sizes: [] },
      { slug: "lon1", name: "London 1", available: true, features: ["backups", "ipv6", "metadata", "storage"], sizes: [] },
    ], links: {}, meta: { total: 4 } }]],

    ["GET", /^\/v2\/account\/keys$/, () => [200, { ssh_keys: [...state.keys.values()], links: {}, meta: { total: state.keys.size } }]],
    ["GET", /^\/v2\/account\/keys\/([0-9a-f:]+)$/, (q, body, [ident]) => {
      const key = [...state.keys.values()].find((k) => k.fingerprint === ident || String(k.id) === ident);
      return key ? [200, { ssh_key: key }] : [404, "not_found", "The resource you were accessing could not be found."];
    }],
    ["POST", /^\/v2\/account\/keys$/, (q, body) => {
      const bad = checkBody("keys", body);
      if (bad) return [422, "unprocessable_entity", bad];
      const blob = Buffer.from(body.public_key.trim().split(/\s+/)[1], "base64");
      const fingerprint = createHash("md5").update(blob).digest("hex").match(/../g).join(":");
      if ([...state.keys.values()].some((k) => k.fingerprint === fingerprint)) {
        return [422, "unprocessable_entity", "SSH Key is already in use on your account"];
      }
      const key = { id: id(), fingerprint, public_key: body.public_key, name: body.name };
      state.keys.set(key.id, key);
      return [201, { ssh_key: key }];
    }],
    ["DELETE", /^\/v2\/account\/keys\/(\d+)$/, (q, body, [kid]) => {
      if (!state.keys.delete(Number(kid))) return [404, "not_found", "The resource you were accessing could not be found."];
      state.deleted.push(`key:${kid}`);
      return [204];
    }],

    ["GET", /^\/v2\/volumes$/, () => [200, { volumes: [...state.volumes.values()], links: {}, meta: { total: state.volumes.size } }]],
    ["GET", /^\/v2\/volumes\/([0-9a-f-]+)$/, (q, body, [vid]) =>
      state.volumes.has(vid) ? [200, { volume: state.volumes.get(vid) }] : [404, "not_found", "volume not found"]],
    ["POST", /^\/v2\/volumes$/, (q, body) => {
      const bad = checkBody("volumes", body);
      if (bad) return [422, "unprocessable_entity", bad];
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(body.name)) return [422, "unprocessable_entity", "invalid volume name"];
      if (opts.volumeTierLimit) return [422, "unprocessable_entity", "This volume would exceed your account's volume size limit of 100 GiB."];
      const vol = { id: randomUUID(), name: body.name, description: body.description ?? "", size_gigabytes: body.size_gigabytes,
        droplet_ids: [], region: { slug: body.region, name: body.region }, filesystem_type: body.filesystem_type ?? "",
        filesystem_label: "", tags: body.tags ?? [], created_at: new Date().toISOString() };
      state.volumes.set(vol.id, vol);
      return [201, { volume: vol }];
    }],
    ["POST", /^\/v2\/volumes\/([0-9a-f-]+)\/actions$/, (q, body, [vid]) => {
      const vol = state.volumes.get(vid);
      if (!vol) return [404, "not_found", "volume not found"];
      const bad = checkBody("volume_action", body);
      if (bad) return [422, "unprocessable_entity", bad];
      const a = action(body.type, body.droplet_id, () => { if (body.type === "detach") vol.droplet_ids = []; });
      return [202, { action: actionJson(a) }];
    }],
    ["DELETE", /^\/v2\/volumes\/([0-9a-f-]+)$/, (q, body, [vid]) => {
      const vol = state.volumes.get(vid);
      if (!vol) return [404, "not_found", "volume not found"];
      if (vol.droplet_ids.length) return [409, "conflict", "volume is attached to a Droplet"];
      state.volumes.delete(vid);
      state.deleted.push(`volume:${vid}`);
      return [204];
    }],

    ["GET", /^\/v2\/droplets$/, (q) => [200, { droplets: [...state.droplets.values()].filter((d) => !q.tag_name || d.tags.includes(q.tag_name)), links: {}, meta: {} }]],
    ["GET", /^\/v2\/droplets\/(\d+)$/, (q, body, [did]) =>
      state.droplets.has(Number(did)) ? [200, { droplet: state.droplets.get(Number(did)) }] : [404, "not_found", "The resource you were accessing could not be found."]],
    ["POST", /^\/v2\/droplets$/, (q, body) => {
      const bad = checkBody("droplets", body);
      if (bad) return [422, "unprocessable_entity", bad];
      if (typeof body.user_data !== "string" || Buffer.byteLength(body.user_data) > 64 * 1024) return [422, "unprocessable_entity", "user_data"];
      for (const k of body.ssh_keys ?? []) if (!state.keys.has(k)) return [422, "unprocessable_entity", `unknown ssh key ${k}`];
      for (const v of body.volumes ?? []) {
        const vol = state.volumes.get(v);
        if (!vol || vol.region.slug !== body.region) return [422, "unprocessable_entity", `volume ${v} is not in ${body.region}`];
      }
      const did = id();
      const n = state.droplets.size + 20;
      const d = { id: did, name: body.name, memory: 16384, vcpus: 8, disk: 320, locked: false, status: "new",
        created_at: new Date().toISOString(), features: [], backup_ids: [], snapshot_ids: [], volume_ids: body.volumes ?? [],
        size_slug: body.size, region: { slug: body.region, name: body.region }, tags: body.tags ?? [], image: { slug: body.image },
        networks: { v4: [], v6: [] }, user_data: body.user_data };
      for (const v of d.volume_ids) state.volumes.get(v).droplet_ids = [did];
      state.droplets.set(did, d);
      const a = action("create", did, () => {
        d.status = "active";
        d.networks.v4 = [{ ip_address: "10.110.0.2", type: "private" }, { ip_address: `198.51.100.${n}`, type: "public" }];
      });
      return [202, { droplet: d, links: { actions: [{ id: a.id, rel: "create", href: `/v2/actions/${a.id}` }] } }];
    }],
    ["DELETE", /^\/v2\/droplets\/(\d+)$/, (q, body, [did]) => {
      const d = state.droplets.get(Number(did));
      if (!d) return [404, "not_found", "The resource you were accessing could not be found."];
      state.droplets.delete(d.id);
      state.deleted.push(`droplet:${d.id}`);
      for (const vol of state.volumes.values()) vol.droplet_ids = vol.droplet_ids.filter((x) => x !== d.id);
      for (const fw of state.firewalls.values()) fw.droplet_ids = fw.droplet_ids.filter((x) => x !== d.id);
      return [204];
    }],

    ["GET", /^\/v2\/firewalls$/, () => [200, { firewalls: [...state.firewalls.values()], links: {}, meta: {} }]],
    ["POST", /^\/v2\/firewalls$/, (q, body) => {
      const bad = checkBody("firewalls", body) ?? checkRules(body.inbound_rules, "sources") ?? checkRules(body.outbound_rules, "destinations");
      if (bad) return [422, "unprocessable_entity", bad];
      if (!(body.inbound_rules?.length || body.outbound_rules?.length)) return [422, "unprocessable_entity", "a firewall needs at least one rule"];
      if (opts.firewallFails) return [422, "unprocessable_entity", "firewall service is unavailable"];
      for (const d of body.droplet_ids ?? []) if (!state.droplets.has(d)) return [422, "unprocessable_entity", `unknown droplet ${d}`];
      const fw = { id: randomUUID(), name: body.name, status: "succeeded", created_at: new Date().toISOString(), pending_changes: [],
        droplet_ids: body.droplet_ids ?? [], tags: body.tags ?? [], inbound_rules: body.inbound_rules ?? [], outbound_rules: body.outbound_rules ?? [] };
      state.firewalls.set(fw.id, fw);
      return [202, { firewall: fw }];
    }],
    ["DELETE", /^\/v2\/firewalls\/([0-9a-f-]+)$/, (q, body, [fid]) => {
      if (!state.firewalls.delete(fid)) return [404, "not_found", "firewall not found"];
      state.deleted.push(`firewall:${fid}`);
      return [204];
    }],

    ["GET", /^\/v2\/actions\/(\d+)$/, (q, body, [aid]) => {
      const a = state.actions.get(Number(aid));
      if (!a) return [404, "not_found", "action not found"];
      if (a.status === "in-progress") {
        a.status = "completed";
        a.completed_at = new Date().toISOString();
        a.onDone();
      }
      return [200, { action: actionJson(a) }];
    }],
  ];

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const url = new URL(req.url, "http://mock");
      const query = Object.fromEntries(url.searchParams);
      let body = null;
      if (raw) {
        try { body = JSON.parse(raw); } catch { return send(res, 400, "bad_request", "invalid JSON"); }
      }
      state.requests.push({ method: req.method, path: url.pathname, query, body, auth: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${opts.token}`) return send(res, 401, "unauthorized", "Unable to authenticate you");
      for (const [method, pattern, handler] of routes) {
        const m = req.method === method && url.pathname.match(pattern);
        if (m) return send(res, ...handler(query, body, m.slice(1)));
      }
      send(res, 404, "not_found", `no route ${req.method} ${url.pathname}`);
    });
  });

  function send(res, status, idOrBody, message) {
    if (status === 204) { res.writeHead(204); return res.end(); }
    const body = typeof idOrBody === "string" ? { id: idOrBody, message, request_id: "test" } : idOrBody;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token: opts.token,
    state,
    billable: () => state.droplets.size + state.volumes.size,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}
