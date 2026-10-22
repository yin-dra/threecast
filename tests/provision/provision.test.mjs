// threecast — MIT License
// Drives `up`, `down`, `ssh` and the tunnel through tests/provision/tc.sh under /bin/bash,
// against mock Hetzner and DigitalOcean APIs and a fake ssh. Nothing here talks to a real cloud.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { md5Fingerprint, startHetzner } from "./mock-hetzner.mjs";
import { startDigitalOcean } from "./mock-digitalocean.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER = join(HERE, "tc.sh");
const FAKE_BIN = join(HERE, "bin");

function newHome() {
  return mkdtempSync(join(tmpdir(), "threecast-test-"));
}

// A clean environment: no inherited cloud tokens, HOME inside the temp dir, and the UTF-8
// locale a macOS terminal sets (bash 3.2 parses "$name…" differently there).
function run(args, env, { onSpawn } = {}) {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", [DRIVER, ...args], {
      env: { PATH: process.env.PATH, HOME: env.THREECAST_HOME, LANG: "en_US.UTF-8", NO_COLOR: "1",
        THREECAST_TEST_SKIP_REMOTE: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    onSpawn?.(child);
    child.on("close", (code) => resolve({ code, stdout, stderr, out: stdout + stderr }));
  });
}

function readTarget(home, name = "threecast") {
  const file = join(home, "targets", `${name}.env`);
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf8").trim().split("\n");
  return Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

function writeTarget(home, name, values) {
  mkdirSync(join(home, "targets"), { recursive: true });
  const text = Object.entries({ NAME: name, ...values }).map(([k, v]) => `${k}=${v}`).join("\n");
  writeFileSync(join(home, "targets", `${name}.env`), `${text}\n`, { mode: 0o600 });
}

function requests(mock, method, path) {
  return mock.state.requests.filter((r) => r.method === method && (path instanceof RegExp ? path.test(r.path) : r.path === path));
}

function firstIndex(mock, method, path) {
  return mock.state.requests.findIndex((r) => r.method === method && r.path === path);
}

const WORLD = ["0.0.0.0/0", "::/0"];

async function hetzner(t, options) {
  const mock = await startHetzner(options);
  t.after(() => mock.close());
  const home = newHome();
  return { mock, home, env: { THREECAST_HOME: home, HCLOUD_API: mock.url, HCLOUD_TOKEN: mock.token } };
}

test("hetzner: up creates key, firewall, volume, then server; down deletes all of it", async (t) => {
  const { mock, home, env } = await hetzner(t, { firewallBusyOnce: true });
  const up = await run(["up", "--provider", "hetzner", "--yes"], env);
  assert.equal(up.code, 0, up.out);

  const key = requests(mock, "POST", "/ssh_keys")[0].body;
  assert.equal(key.name, "threecast-threecast");
  assert.deepEqual(key.labels, { threecast: "threecast" });

  const fw = requests(mock, "POST", "/firewalls")[0].body;
  assert.deepEqual(fw.rules.map((r) => [r.direction, r.protocol, r.port, r.source_ips]),
    [["in", "tcp", "22", WORLD], ["in", "udp", "3382", WORLD]]);

  const vol = requests(mock, "POST", "/volumes")[0].body;
  assert.deepEqual(vol, { name: "threecast-data", size: 1000, location: "fsn1", format: "ext4", automount: false,
    labels: { threecast: "threecast" } });

  const srv = requests(mock, "POST", "/servers")[0].body;
  const volume = [...mock.state.volumes.values()][0];
  const firewall = [...mock.state.firewalls.values()][0];
  assert.equal(srv.server_type, "cpx42");
  assert.equal(srv.location, "fsn1");
  assert.equal(srv.image, "ubuntu-24.04");
  assert.deepEqual(srv.volumes, [volume.id]);
  assert.deepEqual(srv.firewalls, [{ firewall: firewall.id }]);
  assert.equal(srv.automount, false);
  assert.deepEqual(srv.labels, { threecast: "threecast" });
  assert.match(srv.user_data, /^#cloud-config\n/);
  assert.ok(srv.user_data.includes(`DEV=${volume.linux_device}\n`), "cloud-init gets the volume device");
  assert.ok(!srv.user_data.includes("__VOLUME_DEVICE__"));

  // Order matters: nothing billable before the free resources, the volume before the server.
  const order = ["/ssh_keys", "/firewalls", "/volumes", "/servers"].map((p) => firstIndex(mock, "POST", p));
  assert.deepEqual([...order].sort((a, b) => a - b), order);

  const ipUpdates = requests(mock, "PUT", /^\/primary_ips\/\d+$/);
  assert.equal(ipUpdates.length, 2);
  for (const r of ipUpdates) assert.deepEqual(r.body, { labels: { threecast: "threecast" }, auto_delete: true });

  const target = readTarget(home);
  const server = [...mock.state.servers.values()][0];
  const v4 = mock.state.primaryIps.get(server.ipv4);
  assert.equal(target.PROVIDER, "hetzner");
  assert.equal(target.HOST, v4.ip);
  assert.equal(target.SSH_USER, "root");
  assert.equal(target.SSH_KEY, join(home, "ssh", "id_ed25519"));
  assert.equal(target.DATA_DIR, "/root/snapchain");
  assert.equal(target.HZ_SERVER_ID, String(server.id));
  assert.equal(target.HZ_VOLUME_ID, String(volume.id));
  assert.equal(target.HZ_FIREWALL_ID, String(firewall.id));
  assert.equal(target.HZ_SSH_KEY_OWNED, "1");
  assert.equal(target.PUBLIC_API, "0");
  assert.equal(target.TUNNEL_PORT, "13381");
  assert.equal(target.PRICE_CURRENCY, "EUR");
  assert.equal(target.PRICE_HOURLY, "0.2039"); // 0.1114 + 0.0008 + 1000 × 0.0572 / 624
  assert.ok(Math.abs(Number(target.CREATED_AT) - Date.now() / 1000) < 120);
  assert.equal(statSync(join(home, "targets", "threecast.env")).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(home, "current"), "utf8").trim(), "threecast");

  assert.match(up.out, /Billing runs until you run \.\/threecast down/);
  assert.match(up.out, /Next: \.\/threecast node/);
  assert.ok(!up.out.includes(mock.token), "the token is never printed");
  assert.ok(!readFileSync(join(home, "targets", "threecast.env"), "utf8").includes(mock.token));

  const down = await run(["down", "--yes"], env);
  assert.equal(down.code, 0, down.out);
  for (const line of ["Deleted server threecast.", "Deleted volume threecast-data", "Deleted firewall threecast-threecast.",
    "Deleted SSH key threecast-threecast", "Nothing is left."]) {
    assert.ok(down.out.includes(line), `down says: ${line}\n${down.out}`);
  }
  assert.equal(mock.billable(), 0);
  assert.equal(mock.state.firewalls.size + mock.state.sshKeys.size, 0);
  assert.equal(readTarget(home), null);
  assert.ok(!existsSync(join(home, "current")));
});

test("hetzner: a sold-out type moves to the next location and recreates the volume there", async (t) => {
  const { mock, home, env } = await hetzner(t, { soldOut: ["cpx42@fsn1"] });
  // The user's key is already in the project (unlabelled): reuse it, never delete it.
  mkdirSync(join(home, "ssh"), { recursive: true });
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(home, "ssh", "id_ed25519")]);
  const pub = readFileSync(join(home, "ssh", "id_ed25519.pub"), "utf8");
  mock.state.sshKeys.set(1, { id: 1, name: "my laptop", fingerprint: md5Fingerprint(pub), public_key: pub, labels: {} });

  const up = await run(["up", "--provider", "hetzner", "--yes", "--public-api"], env);
  assert.equal(up.code, 0, up.out);
  assert.match(up.out, /cpx42 is sold out in fsn1/);
  assert.equal(requests(mock, "POST", "/ssh_keys").length, 0);

  const volumes = requests(mock, "POST", "/volumes").map((r) => r.body.location);
  assert.deepEqual(volumes, ["fsn1", "nbg1"]);
  assert.equal(mock.state.volumes.size, 1);
  assert.equal([...mock.state.volumes.values()][0].location.name, "nbg1");
  const server = [...mock.state.servers.values()][0];
  assert.equal(server.location, "nbg1");
  assert.equal(server.server_type, "cpx42");

  const rules = requests(mock, "POST", "/firewalls")[0].body.rules.map((r) => `${r.port}/${r.protocol}`);
  assert.deepEqual(rules, ["22/tcp", "3382/udp", "3381/tcp"]);

  const target = readTarget(home);
  assert.equal(target.HZ_SSH_KEY_OWNED, "0");
  assert.equal(target.PUBLIC_API, "1");

  const down = await run(["down", "--yes"], env);
  assert.equal(down.code, 0, down.out);
  assert.equal(mock.billable(), 0);
  assert.ok(mock.state.sshKeys.has(1), "the user's own key stays");
});

test("hetzner: a sold-out type falls back to a dearer one in the same location, keeping the volume", async (t) => {
  const { mock, home, env } = await hetzner(t, { soldOut: ["cpx42@fsn1"] });
  // Only fsn1 is wanted, and the token comes from the credentials file this time.
  delete env.HCLOUD_TOKEN;
  writeFileSync(join(home, "credentials"), `HCLOUD_TOKEN=${mock.token}\n`, { mode: 0o600 });
  const up = await run(["up", "--provider", "hetzner", "--yes", "--location", "fsn1"], env);
  assert.equal(up.code, 0, up.out);
  assert.match(up.out, /Next option: ccx23 in fsn1, about 0.2303 EUR\/hour in total instead of 0.2039/);
  assert.equal(requests(mock, "POST", "/volumes").length, 1);
  assert.equal([...mock.state.servers.values()][0].server_type, "ccx23");
  assert.equal(readTarget(home).PRICE_HOURLY, "0.2303"); // 0.1378 + 0.0008 + 0.0917
});

test("hetzner: the new-account volume cap stops up and leaves nothing behind", async (t) => {
  const { mock, home, env } = await hetzner(t, { volumeLimit: true });
  const up = await run(["up", "--provider", "hetzner", "--yes"], env);
  assert.equal(up.code, 1, up.out);
  assert.match(up.out, /403 resource_limit_exceeded/);
  assert.match(up.out, /1024 GB/);
  assert.match(up.out, /Hetzner Console → Limits/);
  assert.match(up.out, /--provider digitalocean/);
  assert.match(up.out, /Deleted firewall threecast-threecast/);
  assert.match(up.out, /Nothing from this run is left/);
  assert.equal(requests(mock, "POST", "/servers").length, 0);
  assert.equal(mock.billable(), 0);
  assert.equal(mock.state.firewalls.size + mock.state.sshKeys.size, 0);
  assert.equal(readTarget(home), null);
});

test("hetzner: a failure after the volume and server exist deletes them (the rollback trap)", async (t) => {
  const { mock, home, env } = await hetzner(t, { serverActionError: true });
  const up = await run(["up", "--provider", "hetzner", "--yes"], env);
  assert.equal(up.code, 1, up.out);
  assert.match(up.out, /Hetzner could not start the server: action_failed/);
  assert.equal(requests(mock, "POST", "/servers").length, 1);
  for (const kind of ["server", "volume", "firewall", "ssh_key"]) {
    assert.ok(mock.state.deleted.some((d) => d.startsWith(`${kind}:`)), `${kind} deleted`);
  }
  assert.equal(mock.state.deleted.filter((d) => d.startsWith("primary_ip:")).length, 2, "both IP addresses deleted");
  assert.match(up.out, /Deleted server threecast\./);
  assert.match(up.out, /Deleted volume threecast-data/);
  assert.equal(mock.billable(), 0);
  assert.equal(mock.state.firewalls.size + mock.state.sshKeys.size, 0);
  assert.equal(readTarget(home), null);
});

test("hetzner: Ctrl-C while the server is being created deletes everything created so far", async (t) => {
  const { mock, home, env } = await hetzner(t, { serverHangs: true });
  const up = await run(["up", "--provider", "hetzner", "--yes"], env, {
    onSpawn: (child) => {
      const timer = setInterval(() => {
        if (requests(mock, "POST", "/servers").length === 0) return;
        clearInterval(timer);
        setTimeout(() => process.kill(-child.pid, "SIGINT"), 300);
      }, 50);
    },
  });
  assert.equal(up.code, 130, up.out);
  assert.match(up.out, /Setup did not finish/);
  assert.match(up.out, /Nothing from this run is left/);
  assert.equal(mock.billable(), 0);
  assert.equal(mock.state.firewalls.size + mock.state.sshKeys.size, 0);
  assert.equal(readTarget(home), null);
});

test("hetzner: a closed terminal while the server is being created still deletes everything", async (t) => {
  const { mock, home, env } = await hetzner(t, { serverHangs: true });
  const up = await run(["up", "--provider", "hetzner", "--yes"], env, {
    onSpawn: (child) => {
      const timer = setInterval(() => {
        if (mock.state.servers.size === 0) return;
        clearInterval(timer);
        setTimeout(() => {
          // What the shell sees when the terminal window closes: nowhere to print, then SIGHUP.
          child.stdout.destroy();
          child.stderr.destroy();
          process.kill(-child.pid, "SIGHUP");
        }, 300);
      }, 50);
    },
  });
  assert.equal(up.code, 143);
  assert.equal(mock.billable(), 0, mock.state.deleted.join(" "));
  assert.equal(mock.state.firewalls.size + mock.state.sshKeys.size, 0);
  assert.equal(readTarget(home), null);
});

test("hetzner: Ctrl-C while a create request is in flight still deletes what it created", async (t) => {
  const { mock, home, env } = await hetzner(t, { volumeReplyLost: true });
  const up = await run(["up", "--provider", "hetzner", "--yes"], env, {
    onSpawn: (child) => {
      const timer = setInterval(() => {
        if (mock.state.volumes.size === 0) return;
        clearInterval(timer);
        setTimeout(() => process.kill(-child.pid, "SIGINT"), 200);
      }, 50);
    },
  });
  assert.equal(up.code, 130, up.out);
  assert.match(up.out, /Deleted volume threecast-data/);
  assert.equal(mock.billable(), 0);
  assert.equal(mock.state.firewalls.size + mock.state.sshKeys.size, 0);
  assert.equal(readTarget(home), null);
});

test("hetzner: Ctrl-C while POST /servers is in flight also deletes the server's unlabelled IPs", async (t) => {
  const { mock, home, env } = await hetzner(t, { serverReplyLost: true });
  const up = await run(["up", "--provider", "hetzner", "--yes"], env, {
    onSpawn: (child) => {
      const timer = setInterval(() => {
        if (mock.state.servers.size === 0) return;
        clearInterval(timer);
        setTimeout(() => process.kill(-child.pid, "SIGINT"), 200);
      }, 50);
    },
  });
  assert.equal(up.code, 130, up.out);
  assert.match(up.out, /Deleted server threecast\./);
  assert.equal(mock.state.deleted.filter((d) => d.startsWith("primary_ip:")).length, 2, up.out);
  assert.match(up.out, /Deleted IP address 203\.0\.113\.\d+\./);
  assert.match(up.out, /Nothing from this run is left/);
  assert.equal(mock.billable(), 0);
  assert.equal(readTarget(home), null);
});

test("hetzner: a leftover IP address labelled for the name blocks up too", async (t) => {
  const { mock, env } = await hetzner(t);
  mock.addPrimaryIp("ipv4", null, "fsn1", { threecast: "threecast" });
  const up = await run(["up", "--provider", "hetzner", "--yes"], env);
  assert.equal(up.code, 1, up.out);
  assert.match(up.out, /already has IP addresses labelled threecast=threecast/);
  assert.equal(mock.state.requests.filter((r) => r.method !== "GET").length, 0, "up created nothing");

  const down = await run(["down", "--provider", "hetzner", "--yes"], env);
  assert.equal(down.code, 0, down.out);
  assert.match(down.out, /Deleted IP address 203\.0\.113\.\d+\./);
  assert.equal(mock.billable(), 0);
});

// A TCP proxy in front of a mock whose connections can be cut, like a laptop losing Wi-Fi.
async function flakyProxy(t, mockUrl) {
  const target = new URL(mockUrl);
  const proxy = { down: false };
  const sockets = new Set();
  const server = net.createServer((c) => {
    if (proxy.down) return c.destroy();
    const s = net.connect(Number(target.port), "127.0.0.1");
    for (const x of [c, s]) {
      sockets.add(x);
      x.on("close", () => sockets.delete(x));
    }
    c.pipe(s);
    s.pipe(c);
    s.on("error", () => c.destroy());
    c.on("error", () => s.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    for (const x of sockets) x.destroy();
    server.close(resolve);
  }));
  proxy.url = `http://127.0.0.1:${server.address().port}${target.pathname.replace(/\/$/, "")}`;
  return proxy;
}

test("hetzner: a short network drop during up still lets the rollback delete everything", async (t) => {
  const { mock, home, env } = await hetzner(t);
  const proxy = await flakyProxy(t, mock.url);
  const up = await run(["up", "--provider", "hetzner", "--yes"], { ...env, HCLOUD_API: proxy.url }, {
    onSpawn: () => {
      const timer = setInterval(() => {
        if ([...mock.state.volumes.values()][0]?.status !== "available") return;
        clearInterval(timer);
        proxy.down = true;
        setTimeout(() => { proxy.down = false; }, 4000);
      }, 5);
    },
  });
  assert.equal(up.code, 1, up.out);
  assert.match(up.out, /no answer from/);
  assert.match(up.out, /Deleted volume threecast-data/);
  assert.match(up.out, /Nothing from this run is left/);
  assert.equal(mock.billable(), 0);
  assert.equal(readTarget(home), null);
});

test("hetzner: 403 on server create explains the 2026 restriction and cleans up", async (t) => {
  const { mock, env } = await hetzner(t, { serverForbidden: true });
  const up = await run(["up", "--provider", "hetzner", "--yes"], env);
  assert.equal(up.code, 1, up.out);
  assert.match(up.out, /Since 2026-06-26 Hetzner restricts new cloud servers/);
  assert.equal(mock.billable(), 0);
  assert.equal(mock.state.firewalls.size, 0);
});

test("hetzner: a server limit on the account is named as such, and cleans up", async (t) => {
  const { mock, env } = await hetzner(t, { serverLimit: true });
  const up = await run(["up", "--provider", "hetzner", "--yes"], env);
  assert.equal(up.code, 1, up.out);
  assert.match(up.out, /This Hetzner account's limits do not allow a cpx42 server \(403 resource_limit_exceeded: server limit exceeded\)/);
  assert.doesNotMatch(up.out, /Since 2026-06-26/);
  assert.equal(mock.billable(), 0);
});

test("hetzner: leftovers from an interrupted run block up, and down --provider sweeps them", async (t) => {
  const { mock, home, env } = await hetzner(t);
  mock.state.volumes.set(900, { id: 900, name: "threecast-data", size: 1000, server: null, location: { name: "fsn1" },
    linux_device: "/dev/disk/by-id/scsi-0HC_Volume_900", labels: { threecast: "threecast" }, status: "available" });
  const up = await run(["up", "--provider", "hetzner", "--yes"], env);
  assert.equal(up.code, 1, up.out);
  assert.match(up.out, /left from an earlier run/);
  assert.match(up.out, /\.\/threecast down --provider hetzner --name threecast/);
  assert.equal(mock.state.requests.filter((r) => r.method !== "GET").length, 0, "up created nothing");

  const down = await run(["down", "--provider", "hetzner", "--yes"], env);
  assert.equal(down.code, 0, down.out);
  assert.match(down.out, /volume +threecast-data +1000 GB/);
  assert.equal(mock.state.volumes.size, 0);
  assert.equal(readTarget(home), null);
});

test("hetzner: down asks before forgetting a saved server the token's project does not have", async (t) => {
  const { home, env } = await hetzner(t);
  writeTarget(home, "threecast", { PROVIDER: "hetzner", HOST: "203.0.113.9", SSH_USER: "root", HZ_SERVER_ID: "77" });
  const asked = await run(["down"], env);
  assert.equal(asked.code, 1, asked.out);
  assert.match(asked.out, /saved with the address 203\.0\.113\.9, but this Hetzner project has nothing for it/);
  assert.match(asked.out, /this token is from another Hetzner project/);
  assert.ok(readTarget(home), "kept without a yes");

  const forgot = await run(["down", "--yes"], env);
  assert.equal(forgot.code, 0, forgot.out);
  assert.equal(readTarget(home), null);
});

test("hetzner: a location where the type is being retired is never chosen", async (t) => {
  const { mock, env } = await hetzner(t);
  const up = await run(["up", "--provider", "hetzner", "--yes", "--location", "sin", "--server-type", "cpx42"], env);
  assert.equal(up.code, 1, up.out);
  assert.match(up.out, /Hetzner sells none of these server types in sin right now: cpx42/);
  assert.equal(mock.state.requests.filter((r) => r.method !== "GET").length, 0);
});

test("hetzner: after creating, waits for SSH, cloud-init and the mount; a missing mount rolls back", async (t) => {
  const { mock, home, env } = await hetzner(t);
  const remote = { ...env, ...byoEnv(home, {}), THREECAST_TEST_SKIP_REMOTE: "0" };
  const up = await run(["up", "--provider", "hetzner", "--yes"], remote);
  assert.equal(up.code, 0, up.out);
  const log = readFileSync(remote.FAKE_SSH_LOG, "utf8");
  const ip = readTarget(home).HOST;
  assert.match(log, new RegExp(`-i ${join(home, "ssh", "id_ed25519")} -o IdentitiesOnly=yes root@${ip.replace(/\./g, "\\.")} true`));
  for (const cmd of ["cloud-init status --wait >/dev/null", "mountpoint -q /root/snapchain", "df -h /root/snapchain"]) {
    assert.ok(log.includes(`remote: ${cmd}`), `ran ${cmd}`);
  }
  assert.match(up.out, /Volume mounted/);

  const second = await hetzner(t);
  const failing = { ...second.env, ...byoEnv(second.home, {}), THREECAST_TEST_SKIP_REMOTE: "0", FAKE_SSH_FAIL_ON: "mountpoint" };
  const bad = await run(["up", "--provider", "hetzner", "--yes"], failing);
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /The data volume is not mounted at \/root\/snapchain/);
  assert.match(bad.out, /Deleted server threecast\./);
  assert.equal(second.mock.billable(), 0);
  assert.equal(readTarget(second.home), null);

  // A cloud-init error with the volume mounted (a failed apt mirror, say) keeps the server.
  const third = await hetzner(t);
  const degraded = { ...third.env, ...byoEnv(third.home, {}), THREECAST_TEST_SKIP_REMOTE: "0", FAKE_SSH_FAIL_ON: "cloud-init status" };
  const kept = await run(["up", "--provider", "hetzner", "--yes"], degraded);
  assert.equal(kept.code, 0, kept.out);
  assert.match(kept.out, /First-boot setup reported problems \(cloud-init exit code 1\)/);
  assert.ok(readFileSync(degraded.FAKE_SSH_LOG, "utf8").includes("remote: tail -n 20 /var/log/cloud-init-output.log"));
  assert.equal(readTarget(third.home).PROVIDER, "hetzner");
});

test("hetzner: a rejected token names its source and how to make a new one", async (t) => {
  const { env } = await hetzner(t);
  const up = await run(["up", "--provider", "hetzner", "--yes"], { ...env, HCLOUD_TOKEN: "not-the-right-token" });
  assert.equal(up.code, 1, up.out);
  assert.match(up.out, /401 unauthorized\). It came from the HCLOUD_TOKEN environment variable/);
  assert.match(up.out, /Read & Write/);
  assert.ok(!up.out.includes("not-the-right-token"));
});

test("up: refuses an existing name, a bad name, and a missing choice without a terminal", async () => {
  const home = newHome();
  const env = { THREECAST_HOME: home };
  writeTarget(home, "threecast", { PROVIDER: "hetzner", HOST: "203.0.113.9", SSH_USER: "root" });
  const existing = await run(["up", "--provider", "hetzner"], env);
  assert.equal(existing.code, 1);
  assert.match(existing.out, /'threecast' is already set up \(hetzner, 203\.0\.113\.9\)/);
  assert.match(existing.out, /\.\/threecast up --name another-name/);

  const bad = await run(["up", "--name", "My_Node", "--provider", "hetzner"], env);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /'My_Node' cannot be used as a name/);

  const none = await run(["up", "--name", "fresh"], env);
  assert.equal(none.code, 1);
  assert.match(none.out, /--provider hetzner/);
  assert.match(none.out, /--provider digitalocean/);
  assert.match(none.out, /--host root@/);
});

async function digitalocean(t, options) {
  const mock = await startDigitalOcean(options);
  t.after(() => mock.close());
  const home = newHome();
  return { mock, home, env: { THREECAST_HOME: home, DO_API: mock.url, DIGITALOCEAN_TOKEN: mock.token } };
}

test("digitalocean: up creates volume, Droplet and firewall; down deletes all of it", async (t) => {
  const { mock, home, env } = await digitalocean(t);
  const up = await run(["up", "--provider", "digitalocean", "--yes"], env);
  assert.equal(up.code, 0, up.out);

  const vol = requests(mock, "POST", "/v2/volumes")[0].body;
  assert.equal(vol.name, "threecast-data");
  assert.equal(vol.size_gigabytes, 1000);
  assert.equal(vol.region, "fra1");
  assert.equal(vol.filesystem_type, "ext4");
  assert.deepEqual(vol.tags, ["threecast:threecast"]);

  const volume = [...mock.state.volumes.values()][0];
  const key = [...mock.state.keys.values()][0];
  const drop = requests(mock, "POST", "/v2/droplets")[0].body;
  assert.equal(drop.size, "s-8vcpu-16gb");
  assert.equal(drop.image, "ubuntu-24-04-x64");
  assert.equal(drop.region, "fra1");
  assert.deepEqual(drop.volumes, [volume.id]);
  assert.deepEqual(drop.ssh_keys, [key.id]);
  assert.deepEqual(drop.tags, ["threecast:threecast"]);
  assert.ok(drop.user_data.includes("DEV=/dev/disk/by-id/scsi-0DO_Volume_threecast-data\n"));

  const droplet = [...mock.state.droplets.values()][0];
  const fw = requests(mock, "POST", "/v2/firewalls")[0].body;
  assert.equal(fw.name, "threecast-threecast");
  assert.deepEqual(fw.droplet_ids, [droplet.id]);
  assert.deepEqual(fw.inbound_rules.map((r) => [r.protocol, r.ports, r.sources.addresses]),
    [["tcp", "22", WORLD], ["udp", "3382", WORLD]]);
  assert.deepEqual(fw.outbound_rules.map((r) => r.protocol), ["tcp", "udp", "icmp"]);

  const target = readTarget(home);
  assert.equal(target.PROVIDER, "digitalocean");
  assert.equal(target.HOST, droplet.networks.v4.find((n) => n.type === "public").ip_address);
  assert.equal(target.DO_DROPLET_ID, String(droplet.id));
  assert.equal(target.DO_VOLUME_ID, volume.id);
  assert.equal(target.DO_FIREWALL_ID, [...mock.state.firewalls.values()][0].id);
  assert.equal(target.DO_SSH_KEY_ID, String(key.id));
  assert.equal(target.DO_SSH_KEY_OWNED, "1");
  assert.equal(target.PRICE_CURRENCY, "USD");
  assert.equal(target.PRICE_HOURLY, "0.2917"); // 0.14286 + 1000 × 0.10 / 672
  assert.ok(!up.out.includes(mock.token));

  const down = await run(["down", "--yes"], env);
  assert.equal(down.code, 0, down.out);
  assert.match(down.out, /Deleted Droplet threecast\./);
  assert.match(down.out, /Deleted volume threecast-data/);
  assert.match(down.out, /Nothing is left/);
  assert.equal(mock.billable(), 0);
  assert.equal(mock.state.firewalls.size + mock.state.keys.size, 0);
  assert.equal(readTarget(home), null);
});

test("digitalocean: a failure after the volume and Droplet exist deletes them", async (t) => {
  const { mock, home, env } = await digitalocean(t, { firewallFails: true });
  const up = await run(["up", "--provider", "digitalocean", "--yes"], env);
  assert.equal(up.code, 1, up.out);
  assert.equal(requests(mock, "POST", "/v2/droplets").length, 1);
  assert.match(up.out, /Deleted Droplet threecast\./);
  assert.match(up.out, /Deleted volume threecast-data/);
  assert.match(up.out, /Nothing from this run is left/);
  assert.equal(mock.billable(), 0);
  assert.equal(mock.state.keys.size, 0);
  assert.equal(readTarget(home), null);
});

test("digitalocean: a short network drop during up still lets the rollback delete everything", async (t) => {
  const { mock, home, env } = await digitalocean(t);
  const proxy = await flakyProxy(t, mock.url);
  const up = await run(["up", "--provider", "digitalocean", "--yes"], { ...env, DO_API: proxy.url }, {
    onSpawn: () => {
      const timer = setInterval(() => {
        if (mock.state.volumes.size === 0) return;
        clearInterval(timer);
        proxy.down = true;
        setTimeout(() => { proxy.down = false; }, 4000);
      }, 5);
    },
  });
  assert.equal(up.code, 1, up.out);
  assert.match(up.out, /Deleted volume threecast-data/);
  assert.match(up.out, /Nothing from this run is left/);
  assert.equal(mock.billable(), 0);
  assert.equal(mock.state.keys.size, 0);
  assert.equal(readTarget(home), null);
});

test("digitalocean: a tier limit explains Resource Limits and leaves nothing", async (t) => {
  const { mock, env } = await digitalocean(t, { volumeTierLimit: true });
  const up = await run(["up", "--provider", "digitalocean", "--yes"], env);
  assert.equal(up.code, 1, up.out);
  assert.match(up.out, /low resource tier/);
  assert.match(up.out, /Control Panel → Resource Limits/);
  assert.equal(mock.billable(), 0);
  assert.equal(mock.state.keys.size, 0);
});

function byoEnv(home, facts) {
  return {
    THREECAST_HOME: home,
    PATH: `${FAKE_BIN}:${process.env.PATH}`,
    FAKE_SSH_LOG: join(home, "ssh.log"),
    FAKE_SSH_FACTS: Object.entries(facts).map(([k, v]) => `${k}=${v}`).join("\n"),
  };
}

const GOOD_SERVER = { root: "no", sudo: "yes", os: "ubuntu", os_name: "Ubuntu 24.04.3 LTS", arch: "x86_64",
  mem_kib: 16380000, cpus: 8, systemd: "yes", free_kib: 900 * 1024 * 1024 };

test("own server: checks it over SSH and saves it, with sudo for a non-root login", async () => {
  const home = newHome();
  const env = byoEnv(home, GOOD_SERVER);
  const up = await run(["up", "--host", "ubuntu@192.0.2.10"], env);
  assert.equal(up.code, 0, up.out);
  const target = readTarget(home);
  assert.equal(target.PROVIDER, "byo");
  assert.equal(target.HOST, "192.0.2.10");
  assert.equal(target.SSH_USER, "ubuntu");
  assert.equal(target.SSH_KEY, "''");
  assert.equal(target.SUDO, "sudo");
  assert.equal(target.DATA_DIR, "/root/snapchain");
  assert.match(up.out, /allow 3382\/udp inbound/);
  assert.match(up.out, /Grafana, password admin\/admin/);
  assert.match(readFileSync(env.FAKE_SSH_LOG, "utf8"), /remote: sh -s \/root\/snapchain/);

  const down = await run(["down", "--yes", "--purge"], env);
  assert.equal(down.code, 0, down.out);
  const log = readFileSync(env.FAKE_SSH_LOG, "utf8");
  assert.match(log, /remote: sh -s \/root\/snapchain sudo/);
  assert.match(log, /script: dir=\$1/);
  assert.match(log, /remote: sudo rm -rf -- \/root\/snapchain/);
  assert.equal(readTarget(home), null);
});

test("own server: too little RAM is refused; too little disk needs a yes", async () => {
  const small = newHome();
  const ram = await run(["up", "--host", "root@192.0.2.11"], byoEnv(small, { ...GOOD_SERVER, root: "yes", mem_kib: 8000000 }));
  assert.equal(ram.code, 1);
  assert.match(ram.out, /needs 16 GB of RAM; this server has 7 GiB/);

  const container = await run(["up", "--host", "root@192.0.2.13"], byoEnv(newHome(), { ...GOOD_SERVER, root: "yes", systemd: "no" }));
  assert.equal(container.code, 1);
  assert.match(container.out, /This server does not run systemd/);

  const tight = newHome();
  const env = byoEnv(tight, { ...GOOD_SERVER, root: "yes", free_kib: 400 * 1024 * 1024 });
  const asked = await run(["up", "--host", "root@192.0.2.12"], env);
  assert.equal(asked.code, 1);
  assert.match(asked.out, /Only 400 GiB free/);
  assert.match(asked.out, /No terminal to answer on/);
  const accepted = await run(["up", "--host", "root@192.0.2.12", "--yes"], env);
  assert.equal(accepted.code, 0, accepted.out);
  assert.equal(readTarget(tight).SUDO, undefined, "root logins need no sudo");
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test("tunnel: opens once, reuses the open one, moves off a busy port, closes", async (t) => {
  const home = newHome();
  const env = byoEnv(home, {});
  const port = await freePort();
  writeTarget(home, "threecast", { PROVIDER: "byo", HOST: "192.0.2.20", SSH_USER: "root", SSH_KEY: "''", TUNNEL_PORT: port });

  const first = await run(["tunnel-up"], env);
  assert.equal(first.code, 0, first.out);
  assert.equal(first.stdout.trim().split("\n").pop(), `http://127.0.0.1:${port}`);
  const sock = join(home, "run", "threecast.sock");
  assert.ok(readFileSync(env.FAKE_SSH_LOG, "utf8").includes(`-M -S ${sock} -fN -L 127.0.0.1:${port}:127.0.0.1:3381 root@192.0.2.20`));

  const again = await run(["tunnel-up"], env);
  assert.equal(again.code, 0, again.out);
  assert.equal((readFileSync(env.FAKE_SSH_LOG, "utf8").match(/ -M /g) ?? []).length, 1, "no second master");

  const down = await run(["tunnel-down"], env);
  assert.equal(down.code, 0, down.out);
  assert.match(readFileSync(env.FAKE_SSH_LOG, "utf8"), /-O exit/);
  assert.ok(!existsSync(sock));

  const blocker = net.createServer().listen(port, "127.0.0.1");
  t.after(() => blocker.close());
  await new Promise((resolve) => blocker.once("listening", resolve));
  const moved = await run(["tunnel-up"], env);
  assert.equal(moved.code, 0, moved.out);
  assert.match(moved.out, new RegExp(`Port ${port} is taken`));
  assert.equal(readTarget(home).TUNNEL_PORT, String(port + 1));
  assert.equal(moved.stdout.trim().split("\n").pop(), `http://127.0.0.1:${port + 1}`);
});

test("tunnel: the background ssh does not hold this command's output open", async () => {
  const home = newHome();
  const env = { ...byoEnv(home, {}), FAKE_SSH_LINGER: "5" };
  writeTarget(home, "threecast", { PROVIDER: "byo", HOST: "192.0.2.21", SSH_USER: "root", SSH_KEY: "''", TUNNEL_PORT: await freePort() });
  const started = Date.now();
  const r = await run(["tunnel-up"], env);
  assert.equal(r.code, 0, r.out);
  assert.ok(Date.now() - started < 3000, "output closed when tc.sh exited, not when the tunnel did");
});

test("ssh: runs a command on the target", async () => {
  const home = newHome();
  const env = byoEnv(home, {});
  writeTarget(home, "threecast", { PROVIDER: "byo", HOST: "192.0.2.30", SSH_USER: "root", SSH_KEY: "''" });
  const r = await run(["ssh", "uptime"], env);
  assert.equal(r.code, 0, r.out);
  assert.match(readFileSync(env.FAKE_SSH_LOG, "utf8"), /argv: .*root@192\.0\.2\.30 uptime/);
});
