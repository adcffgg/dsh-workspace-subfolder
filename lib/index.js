/**
 * dsh-workspace-subfolder — host half.
 *
 * Registers POST /api/workspace-subfolder, which creates ONE child directory
 * inside a directory already owned by a registered Workspace. The client half
 * normally performs that step through the built-in directory-picker capability
 * (`uiWorkspace.createDirectory`) and only falls back to this route when that
 * capability is missing, so this module stays dependency-free: it declares the
 * web server it needs and nothing else.
 *
 * The route never registers a Workspace itself. Registration goes through the
 * normal Workspace command surface on the client, so the sidebar learns about
 * the new Workspace the same way it learns about "Add Workspace".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

export const name = "workspace-subfolder";
export const inject = ["webServer"];

const ROUTE = "/api/workspace-subfolder";
/** Header a caller must echo; it keeps the route off-limits to stray page scripts. */
const PLUGIN_HEADER = "workspace-subfolder";
const MAX_NAME_LENGTH = 64;
/** Characters Windows forbids in a single path segment. */
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
/** Windows reserved device stems, with or without an extension. */
const RESERVED_STEM = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * DSH home that owns sessions and workspace accounting. Resolved per call so a
 * test can point it at a sandbox without reloading the module.
 */
const dshHome = () => process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const sessionsRoot = () => path.join(dshHome(), "sessions");
const projectionRoot = () => path.join(dshHome(), "storages", "session_projcache", "sessions");
const backupRoot = () => path.join(dshHome(), "backups", "workspace-subfolder");

/** One session id, exactly as DSH spells it. */
const SESSION_ID_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The generation log inside a session directory (compressed or plain). */
const LOG_FILE_RE = /^session\.v\d+\.jsonl(\.zstd)?$/;

/** Send one JSON response. */
function send(response, status, payload) {
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.setHeader("cache-control", "no-store");
	response.end(JSON.stringify(payload));
}

/**
 * Where the client half records that it loaded. Only a running page can reach this
 * route, so a line here is proof that the bundle materialized AND applied; it exists
 * because a failed client bundle aborts the whole web boot, and asking a person to
 * squint at the sidebar is not a check.
 */
const reportFile = () => (process.env.DSH_WORKSPACE_SUBFOLDER_LOG !== undefined && process.env.DSH_WORKSPACE_SUBFOLDER_LOG !== ""
	? process.env.DSH_WORKSPACE_SUBFOLDER_LOG
	: path.join(dshHome(), "logs", "workspace-subfolder.log"));

/** The log grows one line per page rebuild; this keeps it from growing without bound. */
const REPORT_MAX_BYTES = 512 * 1024;

/** Append one self-check line; reporting never becomes a reason to fail a request. */
function appendReport(stage, detail) {
	try {
		const file = reportFile();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		try {
			if (fs.statSync(file).size > REPORT_MAX_BYTES) fs.writeFileSync(file, "");
		} catch {
			/* no file yet is the ordinary first case */
		}
		fs.appendFileSync(file, new Date().toISOString() + " " + stage + (detail === "" ? "" : " — " + detail) + "\n");
	} catch {
		/* a diagnostic that cannot be written is not a reason to refuse the call */
	}
}

/** Read a bounded JSON body. */
async function readBody(request) {
	let text = "";
	for await (const chunk of request) {
		text += chunk;
		if (text.length > 16384) throw new Error("request body too large");
	}
	return text === "" ? {} : JSON.parse(text);
}

/**
 * Validate one folder name as a single portable path segment.
 * @param raw - candidate from the request.
 * @returns the trimmed name, or a human-readable refusal.
 */
function validateName(raw) {
	if (typeof raw !== "string") return { error: "文件夹名称必须是字符串" };
	const value = raw.trim();
	if (value === "") return { error: "请输入文件夹名称" };
	if (value === "." || value === "..") return { error: "「.」与「..」不能作为文件夹名称" };
	if (value.length > MAX_NAME_LENGTH) return { error: "文件夹名称不能超过 " + MAX_NAME_LENGTH + " 个字符" };
	if (INVALID_CHARS.test(value)) return { error: '文件夹名称不能包含 < > : " / \\ | ? * 等字符' };
	if (/[ .]$/.test(value)) return { error: "文件夹名称不能以空格或句点结尾" };
	if (RESERVED_STEM.test(value)) return { error: "该名称是 Windows 保留设备名" };
	return { value };
}

/** Let a detached writer finish flushing before its log is rewritten. */
const DETACH_DRAIN_MS = 500;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a turn is actually in flight for this Session. */
function isRunning(ctx, sessionId) {
	try {
		return ctx.agents?.get?.(sessionId)?.status === "running";
	} catch {
		return false;
	}
}

/**
 * Hand a retained Session back to persistence and let its writer drain.
 *
 * The host keeps every Session it has loaded — even after the user navigated
 * away — so a live entry is NOT the same as work in progress: treating it as
 * such refuses moves on idle conversations. This is the same release the
 * built-in session deletion performs before it touches storage.
 *
 * @returns whether a live Session was released.
 */
async function releaseSession(ctx, sessionId) {
	const sessions = ctx.get("sessions");
	const session = typeof sessions?.get === "function" ? sessions.get(sessionId) : undefined;
	if (session === undefined) return false;
	if (typeof sessions.liveEntryFor !== "function" || typeof sessions.detachEntered !== "function") {
		throw new Error("这个会话还被宿主占用，且无法安全释放：先切到别的会话再试");
	}
	sessions.detachEntered(sessions.liveEntryFor(session));
	return true;
}

/** Compare two directory spellings the way the platform does. */
function samePath(left, right) {
	if (typeof left !== "string" || typeof right !== "string") return false;
	const trim = (value) => value.replace(/[\\/]+$/, "");
	return process.platform === "win32"
		? trim(left).toLowerCase() === trim(right).toLowerCase()
		: trim(left) === trim(right);
}

/** Canonicalize an existing directory, or return undefined. */
function canonicalDirectory(target) {
	try {
		const resolved = fs.realpathSync(target);
		return fs.statSync(resolved).isDirectory() ? resolved : undefined;
	} catch {
		return undefined;
	}
}

/** The Workspace registry that owns directory accounting, when it is reachable. */
function registryOf(ctx) {
	try {
		const registry = typeof ctx.get === "function" ? ctx.get("workspaceRegistry") : undefined;
		return registry ?? ctx.workspaceRegistry;
	} catch {
		return undefined;
	}
}

/**
 * Create the requested child directory.
 * @returns an HTTP status and the JSON payload.
 */
async function createDirectory(ctx, body) {
	const parentRaw = typeof body.parentPath === "string" ? body.parentPath : "";
	if (parentRaw === "") return { status: 400, payload: { error: "缺少 parentPath" } };

	const parent = canonicalDirectory(parentRaw);
	if (parent === undefined) return { status: 400, payload: { error: "父目录不存在或不是目录：" + parentRaw } };

	const registry = registryOf(ctx);
	if (registry !== undefined && typeof registry.list === "function") {
		let owner;
		try {
			owner = registry.list().find((workspace) => samePath(workspace.path, parent));
		} catch (error) {
			ctx.logger?.warn?.("workspace-subfolder: workspace lookup failed: " + String(error));
		}
		if (owner === undefined) {
			return { status: 400, payload: { error: "该目录不是已注册的工作区，无法在其中新建子文件夹：" + parent } };
		}
	}

	const checked = validateName(body.name);
	if (checked.error !== undefined) return { status: 400, payload: { error: checked.error } };

	const target = path.join(parent, checked.value);
	const occupied = (() => {
		try {
			return fs.statSync(target);
		} catch {
			return undefined;
		}
	})();
	if (occupied !== undefined) {
		// A name already taken by a directory is the idempotent case: the caller
		// still registers it. A name taken by anything else is a real refusal,
		// because registering it as a Workspace directory could never succeed.
		if (!occupied.isDirectory()) {
			return { status: 409, payload: { error: "同名文件已存在，无法创建文件夹：" + target } };
		}
		return { status: 200, payload: { ok: true, path: target, existed: true, created: false, parent } };
	}
	try {
		fs.mkdirSync(target);
	} catch (error) {
		if (error?.code === "EEXIST") {
			let raced = false;
			try {
				raced = fs.statSync(target).isDirectory();
			} catch {
				raced = false;
			}
			if (raced) return { status: 200, payload: { ok: true, path: target, existed: true, created: false, parent } };
		}
		return { status: 500, payload: { error: "创建目录失败：" + String(error?.message ?? error) } };
	}
	return {
		status: 200,
		payload: { ok: true, path: target, existed: false, created: true, parent },
	};
}

//#region session move

/**
 * The directory name DSH derives from a project directory. Ported verbatim from
 * dsh-session-persistence-jsonl so a moved log lands exactly where the loader
 * looks for it: any drift here would hide the session instead of moving it.
 */
function projectKey(cwd) {
	if (cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
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
}

/** Whether this Node can decode the .zstd session logs DSH writes. */
const zstdReady = () => typeof zlib.zstdDecompressSync === "function" && typeof zlib.zstdCompressSync === "function";

/** Zstandard frame magic, little-endian as stored in the artifact. */
const ZSTD_MAGIC = 4247762216;
/** DSH writes checksummed frames; the rewrite matches so the artifact stays uniform. */
const CHECKSUM_PARAMS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

/**
 * Locate complete Zstandard frames without decompressing their blocks. Ported
 * from dsh-session-persistence-jsonl: a log is a sequence of independently
 * decodable frames (one per append), and only the first frame carries the header
 * record — the rest is history this plugin must leave byte for byte.
 * @returns complete frame ranges, plus where an incomplete final frame starts.
 */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return { frames, tornStart: start };
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error("会话日志的 Zstandard 帧头损坏，位置 " + offset);
		offset += 4;
		if (offset === buffer.length) return { frames, tornStart: start };
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) throw new Error("会话日志的 Zstandard 帧头保留位非零");
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) return { frames, tornStart: start };
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = (blockHeader >>> 1) & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) throw new Error("会话日志的 Zstandard 块类型非法");
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) return { frames, tornStart: start };
			offset += 4;
		}
		frames.push({ start, end: offset });
		if (frames.length === maxFrames) return { frames };
	}
	return { frames };
}

/** Locate one session's log by scanning the project directories. */
function findSessionLog(sessionId) {
	let projects = [];
	try {
		projects = fs.readdirSync(sessionsRoot());
	} catch {
		return undefined;
	}
	for (const project of projects) {
		const dir = path.join(sessionsRoot(), project, sessionId);
		let entries = [];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			continue;
		}
		const log = entries.find((name) => LOG_FILE_RE.test(name));
		if (log !== undefined) return { dir, log: path.join(dir, log) };
	}
	return undefined;
}

/** Parse and validate one session header record. */
function parseHeader(line) {
	if (typeof line !== "string" || line.trim() === "") throw new Error("会话日志是空的");
	let header;
	try {
		header = JSON.parse(line);
	} catch {
		throw new Error("会话日志的第一行无法解析");
	}
	if (header === null || typeof header !== "object" || header.type !== "session" || typeof header.id !== "string") {
		throw new Error("会话日志的第一行不是 session 头");
	}
	return header;
}

/** Read the header record from the first frame only. */
function readSessionHeader(buffer, logPath) {
	if (!/\.zstd$/.test(logPath)) {
		const lines = buffer.toString("utf8").split("\n");
		return { header: parseHeader(lines[0]), text: lines.join("\n"), frameEnd: 0 };
	}
	const { frames } = scanZstdFrames(buffer, 1);
	if (frames.length === 0) throw new Error("会话日志没有完整的 Zstandard 帧");
	const first = frames[0];
	const text = zlib.zstdDecompressSync(buffer.subarray(first.start, first.end)).toString("utf8");
	const header = parseHeader(text.split("\n")[0]);
	return { header, text, frameEnd: first.end };
}

/** The same log bytes with only the header's cwd replaced; every later frame is kept verbatim. */
function rewriteHeaderCwd(logPath, buffer, header, cwd) {
	const plain = !/\.zstd$/.test(logPath);
	let firstEnd = 0;
	let frameCount = 0;
	let text;
	if (plain) {
		text = buffer.toString("utf8");
	} else {
		const { frames, tornStart } = scanZstdFrames(buffer);
		if (tornStart !== undefined) throw new Error("会话日志末尾有未写完的帧，已拒绝改动");
		if (frames.length === 0) throw new Error("会话日志没有完整的 Zstandard 帧");
		firstEnd = frames[0].end;
		frameCount = frames.length;
		text = zlib.zstdDecompressSync(buffer.subarray(frames[0].start, firstEnd)).toString("utf8");
	}

	const lines = text.split("\n");
	if (parseHeader(lines[0]).id !== header.id) throw new Error("会话日志的第一帧不是该会话的头部");
	const nextText = [JSON.stringify({ ...header, cwd }), ...lines.slice(1)].join("\n");

	if (plain) return Buffer.from(nextText, "utf8");

	const frame = zlib.zstdCompressSync(Buffer.from(nextText, "utf8"), CHECKSUM_PARAMS);
	const out = Buffer.concat([frame, buffer.subarray(firstEnd)]);
	// Verify before the file is touched: the result must scan cleanly, keep the
	// same frame count, and decode back to exactly the text that was written.
	const check = scanZstdFrames(out);
	if (check.tornStart !== undefined) throw new Error("重写后的日志结构校验失败");
	if (check.frames.length !== frameCount) throw new Error("重写后的帧数发生变化");
	// The frames after the header are history: they must be the same bytes.
	if (!out.subarray(check.frames[0].end).equals(buffer.subarray(firstEnd))) throw new Error("重写后的历史帧发生变化");
	const back = zlib.zstdDecompressSync(out.subarray(check.frames[0].start, check.frames[0].end)).toString("utf8");
	if (back !== nextText) throw new Error("重写后的日志自校验失败");
	return out;
}

/**
 * Move one Session's storage and account to another registered Workspace, which
 * is what "put this conversation in that folder" means in DSH: the log lives
 * under a directory derived from its header `cwd`, and workspace membership is
 * validated against that same `cwd`.
 *
 * Refusals are deliberate: a live Session owns its writer, and a rewrite under it
 * would corrupt the log. Everything destructive is backed up first and rolled
 * back when the directory move fails.
 */
async function moveSession(ctx, body) {
	const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
	if (!SESSION_ID_RE.test(sessionId)) return { status: 400, payload: { error: "sessionId 不合法" } };

	const targetRaw = typeof body.targetPath === "string" ? body.targetPath : "";
	if (targetRaw === "") return { status: 400, payload: { error: "缺少 targetPath" } };
	const target = canonicalDirectory(targetRaw);
	if (target === undefined) return { status: 400, payload: { error: "目标目录不存在或不是目录：" + targetRaw } };

	const registry = registryOf(ctx);
	const targetKnown = (() => {
		try {
			return registry?.list?.().some((workspace) => samePath(workspace.path, target)) === true;
		} catch {
			return false;
		}
	})();
	if (!targetKnown) return { status: 400, payload: { error: "目标目录不是已注册的工作区：" + target } };

	if (!zstdReady()) return { status: 501, payload: { error: "当前 Node 不支持 zstd，无法改写会话日志" } };

	if (isRunning(ctx, sessionId)) {
		return { status: 409, payload: { error: "这个会话正在运行，等它跑完再移动它" } };
	}

	// Idle but retained sessions are released here, not refused.
	let released = false;
	try {
		released = await releaseSession(ctx, sessionId);
	} catch (error) {
		return { status: 409, payload: { error: String(error?.message ?? error) } };
	}
	if (released) await delay(DETACH_DRAIN_MS);

	const found = findSessionLog(sessionId);
	if (found === undefined) return { status: 404, payload: { error: "找不到该会话的日志文件" } };

	const buffer = fs.readFileSync(found.log);
	let header;
	try {
		header = readSessionHeader(buffer, found.log).header;
	} catch (error) {
		return { status: 422, payload: { error: "这个会话日志无法安全解析，已拒绝移动：" + String(error?.message ?? error) } };
	}
	if (samePath(header.cwd, target)) {
		return { status: 200, payload: { ok: true, moved: false, unchanged: true, sessionId, from: header.cwd, to: target } };
	}

	const targetProject = path.join(sessionsRoot(), projectKey(target));
	const targetDir = path.join(targetProject, path.basename(found.dir));
	if (!samePath(targetDir, found.dir) && fs.existsSync(targetDir)) {
		return { status: 409, payload: { error: "目标位置已有同名会话目录，已放弃移动" } };
	}

	// Compute the rewritten bytes before anything is touched: the whole-file
	// verification inside refuses here rather than after a partial write.
	let bytes;
	try {
		bytes = rewriteHeaderCwd(found.log, buffer, header, target);
	} catch (error) {
		return { status: 422, payload: { error: "改写会话头失败，未做任何改动：" + String(error?.message ?? error) } };
	}

	// Backup first: the write below is the only destructive step, and this copy is
	// what a rollback restores.
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backup = path.join(backupRoot(), sessionId + "-" + stamp + path.extname(found.log));
	try {
		fs.mkdirSync(backupRoot(), { recursive: true });
		fs.copyFileSync(found.log, backup);
	} catch (error) {
		return { status: 500, payload: { error: "备份会话日志失败，已放弃：" + String(error?.message ?? error) } };
	}

	const temp = found.log + ".move-tmp";
	try {
		fs.writeFileSync(temp, bytes);
		// Flush before the rename: the rename is atomic, but the bytes behind it are
		// not until they reach the disk.
		const handle = fs.openSync(temp, "r+");
		try {
			fs.fsyncSync(handle);
		} finally {
			fs.closeSync(handle);
		}
		fs.renameSync(temp, found.log);
	} catch (error) {
		try {
			fs.rmSync(temp, { force: true });
		} catch {
			/* the temporary already went away */
		}
		return { status: 500, payload: { error: "改写会话日志失败：" + String(error?.message ?? error) } };
	}

	try {
		fs.mkdirSync(targetProject, { recursive: true });
		// Two different cwds can share a project key (the key is truncated), in which
		// case the directory is already where it belongs and only the header changes.
		if (!samePath(targetDir, found.dir)) fs.renameSync(found.dir, targetDir);
	} catch (error) {
		// Put the original log back: the directory did not move, so the cwd must not
		// either, or the loader would look for this session in the wrong place.
		try {
			fs.copyFileSync(backup, found.log);
		} catch (rollbackError) {
			return {
				status: 500,
				payload: {
					error: "移动会话目录失败，且回滚日志也失败；原日志备份在：" + backup,
					rollbackError: String(rollbackError?.message ?? rollbackError),
				},
			};
		}
		return { status: 500, payload: { error: "移动会话目录失败，已回滚：" + String(error?.message ?? error) } };
	}

	// The projection cache still names the old directory; dropping it forces a re-read.
	try {
		fs.rmSync(path.join(projectionRoot(), sessionId + ".json"), { force: true });
	} catch {
		/* a missing cache is the ordinary case */
	}

	// Re-home the account: teach the registry the session's new header, detach it
	// from the old workspace, attach it to the target. A failure here costs the
	// sidebar placement only — the files are already consistent, and a restart
	// re-indexes everything.
	let registryUpdated = false;
	let registryError;
	try {
		// The old workspace is the one that owned the session's previous directory:
		// its sessionIds getter already hides the session once the path changed, so
		// looking it up that way would leave the id dangling in the durable record.
		const workspaces = registry?.list?.() ?? [];
		const source = workspaces.find((workspace) => samePath(workspace.path, header.cwd));
		const destination = workspaces.find((workspace) => samePath(workspace.path, target));

		// One entry, not a full rescan: the rescan asks persistence for every stored
		// header, which means reading every log of the profile on each move.
		let indexed = false;
		if (typeof registry?.indexHeader === "function") {
			await registry.indexHeader({ ...header, cwd: target });
			indexed = true;
		} else if (typeof registry?.replaceHeaderIndex === "function" && typeof registry?.listStoredHeaders === "function") {
			await registry.replaceHeaderIndex(await registry.listStoredHeaders());
			indexed = true;
		}

		if (source !== undefined) await source.detachSession(sessionId);
		if (indexed && destination !== undefined) {
			await destination.attachSession(sessionId);
			registryUpdated = true;
		}
	} catch (error) {
		registryError = String(error?.message ?? error);
		ctx.logger?.warn?.("workspace-subfolder: workspace accounting refresh failed: " + registryError);
	}

	return {
		status: 200,
		payload: {
			ok: true,
			moved: true,
			sessionId,
			from: header.cwd,
			to: target,
			directory: targetDir,
			backup,
			registryUpdated,
			released,
			...(registryUpdated ? {} : { needsRestart: true, ...(registryError === undefined ? {} : { registryError }) }),
		},
	};
}
//#endregion

/**
 * Rename a Workspace's DIRECTORY and keep everything that pointed at the old path
 * consistent: every Session stored under it gets its header `cwd` rewritten and
 * its project directory moved, then the workspace record takes the new path.
 *
 * The sidebar's own rename only changes the display title, so a folder can end up
 * called one thing while its directory is called another; this is the operation
 * that makes the directory follow.
 *
 * Order matters: every new header is verified in memory first, the directory is
 * renamed after them, and each failure undoes what was already done. A live
 * Session owns its writer, so one inside the workspace refuses the whole rename.
 */
async function renameWorkspace(ctx, body) {
	const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
	if (workspaceId === "") return { status: 400, payload: { error: "缺少 workspaceId" } };

	const registry = registryOf(ctx);
	let entity;
	try {
		entity = registry?.get?.(workspaceId);
	} catch {
		entity = undefined;
	}
	if (entity === undefined) return { status: 404, payload: { error: "找不到这个工作区：" + workspaceId } };

	const oldPath = entity.path;
	if (typeof oldPath !== "string" || oldPath === "") return { status: 400, payload: { error: "这个工作区没有关联目录" } };

	const checked = validateName(body.newName);
	if (checked.error !== undefined) return { status: 400, payload: { error: checked.error } };

	const oldName = path.basename(oldPath);
	if (checked.value === oldName) {
		return { status: 200, payload: { ok: true, renamed: false, unchanged: true, from: oldPath, to: oldPath } };
	}

	const parent = path.dirname(oldPath);
	const newPath = path.join(parent, checked.value);
	if (fs.existsSync(newPath)) return { status: 409, payload: { error: "目标目录已存在，已放弃改名：" + newPath } };
	if (!zstdReady()) return { status: 501, payload: { error: "当前 Node 不支持 zstd，无法改写会话日志" } };

	// The sessions physically stored under this workspace's project directory are
	// the ones whose headers name this path: storage is the authoritative list.
	const sourceProject = path.join(sessionsRoot(), projectKey(oldPath));
	let sessionIds = [];
	try {
		sessionIds = fs.readdirSync(sourceProject).filter((name) => SESSION_ID_RE.test(name));
	} catch {
		sessionIds = [];
	}

	for (const id of sessionIds) {
		if (isRunning(ctx, id)) {
			return { status: 409, payload: { error: "这个工作区里有正在运行的会话，等它跑完再改名：" + id } };
		}
	}

	// Idle sessions are retained by the host as well; release them before their
	// headers are rewritten, then let every writer drain once.
	let released = false;
	try {
		for (const id of sessionIds) {
			if (await releaseSession(ctx, id)) released = true;
		}
	} catch (error) {
		return { status: 409, payload: { error: String(error?.message ?? error) } };
	}
	if (released) await delay(DETACH_DRAIN_MS);

	// Phase 1 — compute and verify every new header in memory, and back up each log.
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const prepared = [];
	try {
		fs.mkdirSync(backupRoot(), { recursive: true });
		for (const id of sessionIds) {
			const dir = path.join(sourceProject, id);
			const logName = fs.readdirSync(dir).find((name) => LOG_FILE_RE.test(name));
			if (logName === undefined) continue;
			const logPath = path.join(dir, logName);
			const buffer = fs.readFileSync(logPath);
			const header = readSessionHeader(buffer, logPath).header;
			const bytes = rewriteHeaderCwd(logPath, buffer, header, newPath);
			const backup = path.join(backupRoot(), id + "-rename-" + stamp + path.extname(logName));
			fs.copyFileSync(logPath, backup);
			prepared.push({ id, logPath, bytes, backup, header });
		}
	} catch (error) {
		return { status: 422, payload: { error: "有会话日志无法安全改写，已放弃改名（未做任何改动）：" + String(error?.message ?? error) } };
	}

	/** Put every backed-up log back, whether or not its write had landed. */
	const restoreHeaders = () => {
		for (const item of prepared) {
			try {
				fs.copyFileSync(item.backup, item.logPath);
			} catch {
				/* the log already went back with its directory */
			}
		}
	};

	// Phase 2 — write the new headers.
	try {
		for (const item of prepared) {
			const temp = item.logPath + ".rename-tmp";
			fs.writeFileSync(temp, item.bytes);
			const handle = fs.openSync(temp, "r+");
			try {
				fs.fsyncSync(handle);
			} finally {
				fs.closeSync(handle);
			}
			fs.renameSync(temp, item.logPath);
		}
	} catch (error) {
		for (const item of prepared) {
			try {
				fs.rmSync(item.logPath + ".rename-tmp", { force: true });
			} catch {
				/* the staging file is already gone */
			}
		}
		restoreHeaders();
		return { status: 500, payload: { error: "改写会话头失败，已回滚：" + String(error?.message ?? error) } };
	}

	// Phase 3 — the directory itself.
	try {
		fs.renameSync(oldPath, newPath);
	} catch (error) {
		restoreHeaders();
		return { status: 500, payload: { error: "重命名目录失败，已回滚：" + String(error?.message ?? error) } };
	}

	// Phase 4 — the sessions' storage directories follow their headers.
	const targetProject = path.join(sessionsRoot(), projectKey(newPath));
	try {
		fs.mkdirSync(targetProject, { recursive: true });
		for (const item of prepared) fs.renameSync(path.join(sourceProject, item.id), path.join(targetProject, item.id));
	} catch (error) {
		for (const item of prepared) {
			try {
				const moved = path.join(targetProject, item.id);
				if (fs.existsSync(moved)) fs.renameSync(moved, path.join(sourceProject, item.id));
			} catch {
				/* leave it to the restart index */
			}
		}
		restoreHeaders();
		try {
			fs.renameSync(newPath, oldPath);
		} catch {
			/* the directory never moved, or already went back */
		}
		return { status: 500, payload: { error: "搬迁会话目录失败，已回滚：" + String(error?.message ?? error) } };
	}

	// Phase 5 — accounting: the index learns the new paths, the record takes the new
	// path (pruning keeps the sessions, because their index moved with them), and a
	// title that was only the old directory name follows the directory.
	let registryUpdated = false;
	let registryError;
	try {
		for (const item of prepared) {
			if (typeof registry?.indexHeader === "function") await registry.indexHeader({ ...item.header, cwd: newPath });
		}
		await entity.mutate((record) => ({
			...record,
			path: newPath,
			title: record.title === oldName ? checked.value : record.title,
		}));
		registryUpdated = true;
	} catch (error) {
		registryError = String(error?.message ?? error);
		ctx.logger?.warn?.("workspace-subfolder: workspace rename accounting failed: " + registryError);
	}

	return {
		status: 200,
		payload: {
			ok: true,
			renamed: true,
			workspaceId,
			from: oldPath,
			to: newPath,
			sessions: prepared.length,
			registryUpdated,
			...(registryUpdated ? {} : { needsRestart: true, ...(registryError === undefined ? {} : { registryError }) }),
		},
	};
}

export function apply(ctx) {
	const handle = async (request, response) => {
		const method = request.method ?? "GET";
		if (method !== "POST") return send(response, 405, { error: "method-not-allowed" });
		if (String(request.headers["x-dsh-plugin"] ?? "") !== PLUGIN_HEADER) {
			return send(response, 403, { error: "forbidden" });
		}
		let body;
		try {
			body = await readBody(request);
		} catch (error) {
			return send(response, 400, { error: "bad-body: " + String(error?.message ?? error) });
		}
		const action = typeof body.action === "string" ? body.action : "mkdir";
		if (action === "report") {
			const stage = typeof body.stage === "string" ? body.stage.slice(0, 120) : "unknown";
			const detail = typeof body.detail === "string" ? body.detail.slice(0, 400) : "";
			appendReport(stage, detail);
			return send(response, 200, { ok: true, report: reportFile() });
		}
		if (action === "rename") {
			const result = await renameWorkspace(ctx, body);
			return send(response, result.status, result.payload);
		}
		if (action === "move") {
			const result = await moveSession(ctx, body);
			return send(response, result.status, result.payload);
		}
		if (action !== "mkdir" && action !== "create") {
			return send(response, 400, { error: "bad-action: " + action });
		}
		try {
			const result = await createDirectory(ctx, body);
			return send(response, result.status, result.payload);
		} catch (error) {
			ctx.logger?.warn?.("workspace-subfolder: mkdir failed: " + String(error));
			return send(response, 500, { error: "创建目录失败：" + String(error?.message ?? error) });
		}
	};

	/**
	 * Every answer already guards itself; this is the floor under the handler so a
	 * future edit that misses a branch costs a status instead of a rejected
	 * request. A response that is already gone is not a failure worth reporting.
	 */
	const handler = async (request, response) => {
		try {
			await handle(request, response);
		} catch (error) {
			ctx.logger?.warn?.("workspace-subfolder: request handler failed: " + String(error));
			try {
				send(response, 500, { error: "请求失败：" + String(error?.message ?? error) });
			} catch {
				/* the response is already closed */
			}
		}
	};

	// One line per host load: it is how a page reload can be told from a host
	// reload, and which actions the running host actually answers.
	appendReport("host-applied", "actions=mkdir,move,rename,report");

	// Registering the fallback route must never be the reason a host entry fails:
	// the client half reaches the built-in directory capability first anyway, so a
	// refusal here costs the fallback and nothing else.
	try {
		ctx.effect(
			() => ctx.webServer.register({ kind: "exact", path: ROUTE, handler }),
			"workspace-subfolder: route",
		);
	} catch (error) {
		ctx.logger?.warn?.("workspace-subfolder: could not register its route: " + String(error));
	}
}
