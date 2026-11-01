/**
 * Host-half selftest for dsh-workspace-subfolder.
 *
 * Runs the registered route handler directly against a temporary directory with
 * a stub Workspace registry, so the validation, ownership and mkdir behaviour is
 * checked without a running app:
 *
 *   node selftest.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wsf-test-"));
const reportFile = path.join(root, "workspace-subfolder.log");
process.env.DSH_WORKSPACE_SUBFOLDER_LOG = reportFile;
const parent = path.join(root, "parent-workspace");
const outsider = path.join(root, "not-a-workspace");
fs.mkdirSync(parent, { recursive: true });
fs.mkdirSync(outsider, { recursive: true });
fs.writeFileSync(path.join(parent, "occupied"), "file, not a directory");

const module_ = await import(new URL("./lib/index.js", import.meta.url).href);

let route = null;
const moduleCtx = {
	effect: (fn) => {
		const off = fn();
		return off;
	},
	webServer: {
		register: (spec) => {
			route = spec;
			return () => {};
		},
	},
	logger: { warn: () => {} },
	get: (service) => (service === "workspaceRegistry" ? { list: () => [{ id: "ws-1", path: parent, title: "parent" }] } : undefined),
};
module_.apply(moduleCtx);
console.log("route:", route?.path, "| kind:", route?.kind);
if (route === null) throw new Error("the route was not registered");

const makeResponse = () => {
	const response = { statusCode: 0, headers: {}, body: "" };
	response.setHeader = (key, value) => {
		response.headers[key] = value;
	};
	response.end = (text) => {
		response.body = text;
	};
	return response;
};
const makeRequest = (method, headers, payload) => ({
	method,
	headers,
	async *[Symbol.asyncIterator]() {
		if (payload !== undefined) yield payload;
	},
});
const call = async (method, headers, payload) => {
	const response = makeResponse();
	await route.handler(makeRequest(method, headers, payload === undefined ? undefined : JSON.stringify(payload)), response);
	return { status: response.statusCode, json: response.body === "" ? null : JSON.parse(response.body) };
};

const H = { "x-dsh-plugin": "workspace-subfolder" };
const results = [];
const check = async (label, expected, actual) => {
	const ok = expected === actual;
	results.push(ok);
	console.log((ok ? "ok   " : "FAIL ") + label + " -> " + JSON.stringify(actual));
};

await check("GET is refused", 405, (await call("GET", H)).status);
await check("missing plugin header", 403, (await call("POST", {}, { action: "mkdir", parentPath: parent, name: "a" })).status);
await check("unknown action", 400, (await call("POST", H, { action: "delete", parentPath: parent, name: "a" })).status);
await check("missing parentPath", 400, (await call("POST", H, { action: "mkdir", name: "a" })).status);
await check("missing parent directory", 400, (await call("POST", H, { action: "mkdir", parentPath: path.join(root, "nope"), name: "a" })).status);
await check("unregistered parent", 400, (await call("POST", H, { action: "mkdir", parentPath: outsider, name: "a" })).status);
await check("blank name", 400, (await call("POST", H, { action: "mkdir", parentPath: parent, name: "   " })).status);
await check("dot name", 400, (await call("POST", H, { action: "mkdir", parentPath: parent, name: ".." })).status);
await check("separator in name", 400, (await call("POST", H, { action: "mkdir", parentPath: parent, name: "a/b" })).status);
await check("windows reserved name", 400, (await call("POST", H, { action: "mkdir", parentPath: parent, name: "con" })).status);
await check("trailing period", 400, (await call("POST", H, { action: "mkdir", parentPath: parent, name: "abc." })).status);
await check("existing file target", 409, (await call("POST", H, { action: "mkdir", parentPath: parent, name: "occupied" })).status);

const created = await call("POST", H, { action: "mkdir", parentPath: parent, name: " 子文件夹 " });
await check("create status", 200, created.status);
await check("create reports created", true, created.json?.created);
await check("directory exists", true, fs.existsSync(path.join(parent, "子文件夹")) && fs.statSync(path.join(parent, "子文件夹")).isDirectory());

const again = await call("POST", H, { action: "mkdir", parentPath: parent, name: "子文件夹" });
await check("repeat reports existed", true, again.json?.existed);
await check("repeat does not fail", 200, again.status);

const nested = await call("POST", H, { action: "mkdir", parentPath: path.join(parent, "子文件夹"), name: "deeper" });
await check("parent may be a workspace subdirectory once registered", 400, nested.status);

// The client half proves it loaded by reporting through this route.
await check("report accepted", 200, (await call("POST", H, { action: "report", stage: "client-applied", detail: "inject=slots" })).status);
await check("report is written", true, fs.readFileSync(reportFile, "utf8").includes("client-applied — inject=slots"));
await check("report still refuses a bad action", 400, (await call("POST", H, { action: "nope" })).status);

fs.rmSync(root, { recursive: true, force: true });

//#region session move
/**
 * A sandbox home with one synthetic session log and a stub registry. The move is
 * the only destructive operation this plugin performs, so it is exercised here
 * against a fake DSH home before it ever touches a real conversation.
 */
const zlib = await import("node:zlib");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "wsf-home-"));
process.env.DSH_HOME = home;
const oldCwd = path.join(home, "workspace-old");
const newCwd = path.join(home, "workspace-new");
fs.mkdirSync(oldCwd, { recursive: true });
fs.mkdirSync(newCwd, { recursive: true });

/** Local copy of the persistence naming rule, used only to assert placement. */
const projectKey = (cwd) => {
	let readable = "";
	let separatorRun = false;
	for (const ch of cwd) {
		const code = ch.charCodeAt(0);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return "--" + (readable.replace(/^-+/, "") || "root").slice(0, 251) + "--";
};

const sessionId = "session-11111111-2222-3333-4444-555555555555";
const oldDir = path.join(home, "sessions", "project-old", sessionId);
fs.mkdirSync(oldDir, { recursive: true });
const header = { type: "session", version: 4, id: sessionId, createdAt: 1, cwd: oldCwd, isSeeded: false, delegationDepth: 0, agentPreset: "ptc" };
const event = { type: "turn/start", seq: 1 };
const event2 = { type: "turn/end", seq: 2 };
// DSH appends one Zstandard frame per batch; a move must rewrite only frame 0.
const frameOf = (value) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(value) + "\n", "utf8"));
const logPath = path.join(oldDir, "session.v4.jsonl.zstd");
const originalBuffer = Buffer.concat([frameOf(header), frameOf(event), frameOf(event2)]);
fs.writeFileSync(logPath, originalBuffer);

/** Frame offsets by magic scan; enough for a test whose frames are hand-built. */
const frameStarts = (buffer) => {
  const starts = [];
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  let at = 0;
  for (;;) {
    const found = buffer.indexOf(magic, at);
    if (found < 0) return starts;
    starts.push(found);
    at = found + 1;
  }
};
const originalTail = originalBuffer.subarray(frameStarts(originalBuffer)[1]);
fs.mkdirSync(path.join(home, "storages", "session_projcache", "sessions"), { recursive: true });
fs.writeFileSync(path.join(home, "storages", "session_projcache", "sessions", sessionId + ".json"), "{}");

const registryCalls = [];
const sourceEntity = {
	path: oldCwd,
	sessionIds: [sessionId],
	detachSession: async (id) => {
		registryCalls.push("detach:" + id);
		sourceEntity.sessionIds = sourceEntity.sessionIds.filter((candidate) => candidate !== id);
	},
};
const targetEntity = {
	path: newCwd,
	sessionIds: [],
	attachSession: async (id) => {
		registryCalls.push("attach:" + id);
		targetEntity.sessionIds = [...targetEntity.sessionIds, id];
	},
};
const fakeRegistry = {
	list: () => [sourceEntity, targetEntity],
	indexHeader: async () => {
		registryCalls.push("index");
	},
	replaceHeaderIndex: async () => {
		registryCalls.push("reindex");
	},
	listStoredHeaders: async () => [],
};
let liveSession = undefined;
let agentRunning = false;
let detachCalls = 0;
const sessionStub = {
	get: (id) => (id === sessionId ? liveSession : undefined),
	liveEntryFor: (session) => ({ session }),
	detachEntered: () => {
		detachCalls += 1;
		liveSession = undefined;
	},
};
const moveCtx = {
	effect: (fn) => {
		fn();
		return () => {};
	},
	webServer: { register: () => () => {} },
	logger: { warn: () => {} },
	agents: { get: (id) => (id === sessionId && agentRunning ? { status: "running" } : undefined) },
	get: (service) => {
		if (service === "workspaceRegistry") return fakeRegistry;
		if (service === "sessions") return sessionStub;
		return undefined;
	},
};
const moveModule = await import(new URL("./lib/index.js", import.meta.url).href + "?move=1");
let moveRoute = null;
moveModule.apply({ ...moveCtx, webServer: { register: (spec) => { moveRoute = spec; return () => {}; } } });
const moveCall = async (payload) => {
	const response = makeResponse();
	await moveRoute.handler(makeRequest("POST", H, JSON.stringify(payload)), response);
	return { status: response.statusCode, json: response.body === "" ? null : JSON.parse(response.body) };
};

await check("move: bad session id", 400, (await moveCall({ action: "move", sessionId: "nope", targetPath: newCwd })).status);
await check("move: unknown target", 400, (await moveCall({ action: "move", sessionId, targetPath: path.join(home, "nope") })).status);

// A turn in flight is the one case that must refuse: releasing its writer would
// cut the run off.
agentRunning = true;
const runningAttempt = await moveCall({ action: "move", sessionId, targetPath: newCwd });
agentRunning = false;
await check("move: a running session is refused", 409, runningAttempt.status);
await check("move: the refusal names the run", true, String(runningAttempt.json?.error ?? "").includes("正在运行"));

// Retained but idle is the normal case for a conversation the user opened once:
// it is released to the host, not refused.
liveSession = { id: sessionId };
detachCalls = 0;
const moved = await moveCall({ action: "move", sessionId, targetPath: newCwd });
await check("move: an idle retained session is released, not refused", true, moved.json?.released);
await check("move: the host was asked to hand it back", 1, detachCalls);
await check("move: accepted", 200, moved.status);
await check("move: reported moved", true, moved.json?.moved);
await check("move: registry rehomed", true, moved.json?.registryUpdated);

const newDir = path.join(home, "sessions", projectKey(newCwd), sessionId);
await check("move: log at the new project", true, fs.existsSync(path.join(newDir, "session.v4.jsonl.zstd")));
await check("move: old directory gone", false, fs.existsSync(oldDir));

const movedBuffer = fs.readFileSync(path.join(newDir, "session.v4.jsonl.zstd"));
const movedStarts = frameStarts(movedBuffer);
const decodeFrame = (buffer, starts, index) =>
  zlib.zstdDecompressSync(buffer.subarray(starts[index], starts[index + 1] ?? buffer.length)).toString("utf8").trim();
await check("move: header cwd rewritten", newCwd, JSON.parse(decodeFrame(movedBuffer, movedStarts, 0)).cwd);
await check("move: history frame 1 untouched", JSON.stringify(event), decodeFrame(movedBuffer, movedStarts, 1));
await check("move: history frame 2 untouched", JSON.stringify(event2), decodeFrame(movedBuffer, movedStarts, 2));
await check("move: frame count preserved", 3, movedStarts.length);
await check("move: later frames are byte-identical", true, movedBuffer.subarray(movedStarts[1]).equals(originalTail));
await check("move: size grew only by the re-encoded header", true, Math.abs(movedBuffer.length - originalBuffer.length) < 200);
await check("move: backup written", true, fs.existsSync(String(moved.json?.backup)));
await check("move: projection cache dropped", false, fs.existsSync(path.join(home, "storages", "session_projcache", "sessions", sessionId + ".json")));
await check("move: accounting order", "index,detach:" + sessionId + ",attach:" + sessionId, registryCalls.join(","));

const sameTarget = await moveCall({ action: "move", sessionId, targetPath: newCwd });
await check("move: same workspace is a no-op", true, sameTarget.json?.unchanged);
await check("move: no-op does not touch accounting", 3, registryCalls.length);

// Moving back exercises the fallback for a registry without the single-header
// index, and proves the round trip is not one-way.
delete fakeRegistry.indexHeader;
const back = await moveCall({ action: "move", sessionId, targetPath: oldCwd });
await check("move: moving back is accepted", true, back.json?.moved);
await check("move: back at the original project key", true, fs.existsSync(path.join(home, "sessions", projectKey(oldCwd), sessionId, "session.v4.jsonl.zstd")));
const backHeader = JSON.parse(
	zlib.zstdDecompressSync(fs.readFileSync(path.join(home, "sessions", projectKey(oldCwd), sessionId, "session.v4.jsonl.zstd"))).toString("utf8").split("\n")[0],
);
await check("move: header restored to the original cwd", oldCwd, backHeader.cwd);
await check("move: full-rescan fallback used", true, registryCalls.includes("reindex"));
//#endregion


//#region renaming a workspace directory
// The sidebar's rename only changes the title; this action moves the directory
// and every session's header with it. Exercised here against a sandbox home.
const renameId = "ws-rename-1";
const renameOld = path.join(home, "folder-old");
const renameNew = path.join(home, "folder-new");
fs.mkdirSync(renameOld, { recursive: true });
const renameSession = "session-99999999-8888-7777-6666-555555555555";
const renameProject = path.join(home, "sessions", projectKey(renameOld), renameSession);
fs.mkdirSync(renameProject, { recursive: true });
const renameHeader = { type: "session", version: 4, id: renameSession, createdAt: 2, cwd: renameOld, isSeeded: false, delegationDepth: 0, agentPreset: "ptc" };
fs.writeFileSync(path.join(renameProject, "session.v4.jsonl.zstd"), frameOf(renameHeader));

const renameRecord = { path: renameOld, title: "folder-old", sessionIds: [renameSession], createdAt: "x", updatedAt: "x" };
const renameCalls = [];
const renameEntity = {
	id: renameId,
	get path() {
		return renameRecord.path;
	},
	async mutate(fn) {
		Object.assign(renameRecord, fn(renameRecord));
		renameCalls.push("mutate");
	},
};
const renameRegistry = {
	get: (id) => (id === renameId ? renameEntity : undefined),
	list: () => [],
	indexHeader: async () => {
		renameCalls.push("index");
	},
};
const renameCtx = {
	effect: (fn) => {
		fn();
		return () => {};
	},
	webServer: { register: () => () => {} },
	logger: { warn: () => {} },
	get: (service) => {
		if (service === "workspaceRegistry") return renameRegistry;
		if (service === "sessions") return { get: (id) => (id === renameSession ? liveSession : undefined) };
		return undefined;
	},
};
const renameModule = await import(new URL("./lib/index.js", import.meta.url).href + "?rename=1");
let renameRoute = null;
renameModule.apply({ ...renameCtx, webServer: { register: (spec) => { renameRoute = spec; return () => {}; } } });
const renameCall = async (payload) => {
	const response = makeResponse();
	await renameRoute.handler(makeRequest("POST", H, JSON.stringify(payload)), response);
	return { status: response.statusCode, json: response.body === "" ? null : JSON.parse(response.body) };
};

await check("rename: unknown workspace", 404, (await renameCall({ action: "rename", workspaceId: "nope", newName: "x" })).status);
await check("rename: bad name", 400, (await renameCall({ action: "rename", workspaceId: renameId, newName: "a/b" })).status);
await check("rename: same name is a no-op", true, (await renameCall({ action: "rename", workspaceId: renameId, newName: "folder-old" })).json?.unchanged);

liveSession = { id: renameSession };
const renameLive = await renameCall({ action: "rename", workspaceId: renameId, newName: "folder-new" });
liveSession = undefined;
await check("rename: a session the host cannot release refuses the rename", 409, renameLive.status);
await check("rename: the directory did not move", true, fs.existsSync(renameOld));

fs.mkdirSync(renameNew, { recursive: true });
await check("rename: existing target refused", 409, (await renameCall({ action: "rename", workspaceId: renameId, newName: "folder-new" })).status);
fs.rmdirSync(renameNew);

const renamed = await renameCall({ action: "rename", workspaceId: renameId, newName: "folder-new" });
await check("rename: accepted", 200, renamed.status);
await check("rename: reported renamed", true, renamed.json?.renamed);
await check("rename: one session followed", 1, renamed.json?.sessions);
await check("rename: directory moved", true, fs.existsSync(renameNew) && !fs.existsSync(renameOld));
await check("rename: record path updated", renameNew, renameRecord.path);
await check("rename: title followed the directory", "folder-new", renameRecord.title);
await check("rename: index learned the new path", true, renameCalls.includes("index"));

const renameMovedLog = path.join(home, "sessions", projectKey(renameNew), renameSession, "session.v4.jsonl.zstd");
await check("rename: session storage followed", true, fs.existsSync(renameMovedLog));
await check("rename: old session project gone", false, fs.existsSync(renameProject));
const renameMovedHeader = JSON.parse(zlib.zstdDecompressSync(fs.readFileSync(renameMovedLog)).toString("utf8").split("\n")[0]);
await check("rename: header cwd follows", renameNew, renameMovedHeader.cwd);
//#endregion

const failed = results.filter((ok) => !ok).length;
console.log(failed === 0 ? "ALL " + results.length + " CHECKS PASSED" : failed + " CHECK(S) FAILED");
process.exitCode = failed === 0 ? 0 : 1;
