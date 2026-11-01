/**
 * Client-half smoketest for dsh-workspace-subfolder.
 *
 * The browser half needs React and the UI primitives, which only exist inside
 * the running page. This test therefore supplies a minimal hook runtime plus
 * stub stores, calls the component functions directly, and drives the dialog's
 * Create button — so the slot registration, the render tree, the directory
 * capability fallback, the Workspace registration and the grouping switch are
 * all exercised without a browser:
 *
 *   node smoketest.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";


const original = fs.readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
if (!original.includes("const [open, setOpen] = react.useState(false);")) {
	throw new Error("smoketest: the action's open state moved; update this test");
}
// Force the dialog open so one render covers both the action and its dialog.
const source = original.replace(
	"const [open, setOpen] = react.useState(false);",
	"const [open, setOpen] = react.useState(true);",
);
const clientCopy = path.join(os.tmpdir(), "dsh-workspace-subfolder-client-" + process.pid + ".mjs");
fs.writeFileSync(clientCopy, source, "utf8");

// The component picks its language once, when the bundle is evaluated.
Object.defineProperty(globalThis, "navigator", { value: { language: "zh-CN" }, configurable: true, writable: true });

const results = [];
const check = (label, expected, actual) => {
	const ok = JSON.stringify(expected) === JSON.stringify(actual);
	results.push(ok);
	console.log((ok ? "ok   " : "FAIL ") + label + " -> " + JSON.stringify(actual));
};

//#region minimal react
/**
 * Just enough React to call the components directly: hooks are backed by one
 * frame per component function, and effects run and re-render until a pass
 * registers no further effect. Host elements keep their children so the tree
 * can be walked afterwards.
 */
const frames = new Map();
let activeFrame = null;

const react = {
	Fragment: Symbol("Fragment"),
	useState(initial) {
		const frame = activeFrame;
		const index = frame.stateCursor++;
		if (!(index in frame.store.state)) {
			frame.store.state[index] = typeof initial === "function" ? initial() : initial;
		}
		return [
			frame.store.state[index],
			(value) => {
				frame.store.state[index] = typeof value === "function" ? value(frame.store.state[index]) : value;
			},
		];
	},
	useEffect(fn) {
		activeFrame.effects.push(fn);
	},
	useRef(initial) {
		const frame = activeFrame;
		const index = frame.refCursor++;
		if (!(index in frame.store.refs)) frame.store.refs[index] = { current: initial };
		return frame.store.refs[index];
	},
	useCallback(fn) {
		return fn;
	},
};

/** Mirrors react/jsx-runtime: the third argument is a key, never children. */
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });

const primitive = (fn) => {
	fn.__primitive = true;
	return fn;
};
const primitives = {
	Modal: primitive(function Modal() {}),
	Button: primitive(function Button() {}),
	MenuItemButton: primitive(function MenuItemButton() {}),
	IconProjectAddOutlineRegular: primitive(function IconProjectAddOutlineRegular() {}),
	IconFolderOpenRegular: primitive(function IconFolderOpenRegular() {}),
};
//#endregion

const require_ = (specifier) => {
	if (specifier === "react") return react;
	if (specifier === "react/jsx-runtime") return { jsx, jsxs: jsx };
	if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
	throw new Error("unexpected require: " + specifier);
};

let plugin = null;
globalThis.window = {
	__ModuleLoader__: {
		load(spec) {
			plugin = spec.factory(require_);
		},
	},
};

// A page evaluates the bundle as a classic script: nothing but globals is in
// scope, so the factory may only rely on the `require` the module system passes
// it. Declaring an outer `module` here would hide exactly the bug this test
// exists to catch.
new Function(source)();
if (plugin === null) throw new Error("smoketest: the client module never registered itself");

//#region fake host context
const store = (value) => ({
	getSnapshot: () => value,
	subscribe: () => () => {},
});

const workspaceItems = [
	{ workspaceId: "ws-1", path: "C:\\work\\parent", title: "parent", sessionIds: [] },
	{ workspaceId: "ws-2", path: "C:\\work\\other", title: "other", sessionIds: [] },
];
const created = [];
const grouped = [];
const sessionRefreshes = [];
let selectedSessionId = "session-9";
const directoryCalls = [];
const routeCalls = [];
let serviceDirectory = true;

const services = {
	workspaces: {
		list: store({ items: workspaceItems }),
		create: async (input) => {
			created.push(input.path);
			return { workspaceId: "ws-new", path: input.path, title: "论文" };
		},
	},
	sessions: {
		list: store({ ids: ["session-1"], byId: { "session-1": { cwd: "C:\\work\\parent" } } }),
		// The real ClientSessions service publishes `refresh()`; `refreshList()` is only
		// the manager method behind it and is NOT on the service, so a stub offering
		// it would hide exactly the bug this test exists to catch.
		refresh: async () => {
			sessionRefreshes.push("refresh");
		},
		refreshProjections: async (id) => {
			sessionRefreshes.push(id);
		},
	},
	uiWorkspace: {
		// The main view normally shows a DIFFERENT conversation than the one being
		// moved; the tests that need the viewing case change this variable.
		selection: { getSnapshot: () => ({ sessionId: selectedSessionId }) },
		view: {
			setGroupBy: (mode) => {
				grouped.push(mode);
			},
		},
		createDirectory: async (parent, name) => {
			directoryCalls.push(parent + "|" + name);
			return parent + "\\" + name;
		},
	},
};

globalThis.fetch = async (url, options) => {
	const payload = JSON.parse(options.body);
	routeCalls.push({ url, payload, headers: options.headers });
	if (payload.action === "rename") {
		return {
			ok: true,
			status: 200,
			json: async () => ({ ok: true, renamed: true, from: "C:\\work\\parent", to: "C:\\work\\" + payload.newName, sessions: 1, registryUpdated: true }),
		};
	}
	if (payload.action === "move") {
		return {
			ok: true,
			status: 200,
			json: async () => ({ ok: true, moved: true, from: "C:\\work\\parent", to: payload.targetPath, backup: "C:\\backup.zst", registryUpdated: true }),
		};
	}
	return {
		ok: true,
		status: 200,
		json: async () => ({ ok: true, path: payload.parentPath + "\\" + payload.name, existed: false, created: true }),
	};
};

const registered = [];
const ctx = {
	get: (service) => services[service],
	slots: {
		inject: (slot, generator) => {
			for (const value of generator()) registered.push({ slot, value });
		},
		register: (spec, component) => {
			registered.push({ spec, component });
			return () => {};
		},
	},
};
//#endregion

plugin.apply(ctx);
check("plugin exports a name", "workspace-subfolder", plugin.name);
check("plugin exports inject", ["slots"], plugin.inject);
const slotRegistrations = registered.filter((entry) => entry.component !== undefined);
check("two slot registrations", 2, slotRegistrations.length);
check("registered in the sidebar foot", true, slotRegistrations.some((entry) => entry.spec?.name === "sidebar.footer.action"));
check("registered in the session menu", true, slotRegistrations.some((entry) => entry.spec?.name === "sidebar.workspaces.session.menu.item"));

const Action = slotRegistrations.find((entry) => entry.spec?.name === "sidebar.footer.action").component;
const MoveMenuItem = slotRegistrations.find((entry) => entry.spec?.name === "sidebar.workspaces.session.menu.item").component;

//#region mini renderer
function instantiate(Component, props) {
	const store_ = frames.get(Component) ?? { state: [], refs: [] };
	frames.set(Component, store_);
	let tree;
	for (let pass = 0; pass < 6; pass += 1) {
		const frame = { store: store_, stateCursor: 0, refCursor: 0, effects: [] };
		const previous = activeFrame;
		activeFrame = frame;
		try {
			tree = Component(props);
		} finally {
			activeFrame = previous;
		}
		if (frame.effects.length === 0) break;
		for (const effect of frame.effects) effect();
	}
	return tree;
}

function expandChildren(children) {
	if (Array.isArray(children)) return children.map(expand);
	return expand(children);
}

function expand(node) {
	if (node === null || node === undefined || typeof node !== "object") return node;
	if (Array.isArray(node)) return node.map(expand);
	if (node.type === react.Fragment) return expand(node.props?.children);
	if (typeof node.type === "function" && node.type.__primitive !== true) {
		return expand(instantiate(node.type, node.props));
	}
	return { ...node, props: { ...node.props, children: expandChildren(node.props?.children) } };
}

function render(Component, props) {
	return expand(instantiate(Component, props));
}

function collect(node, out = []) {
	if (node === null || node === undefined || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		for (const child of node) collect(child, out);
		return out;
	}
	out.push(node);
	// A Modal keeps its actions in a `footer` prop, so walk that too.
	collect(node.props?.children, out);
	collect(node.props?.footer, out);
	return out;
}

const textsOf = (tree) =>
	collect(tree)
		.map((node) => node.props?.children)
		.filter((child) => typeof child === "string");

const buttonByLabel = (tree, label) =>
	collect(tree)
		.filter((node) => node.props?.children === label)
		.pop();

/** Let the click handler's async chain (directory -> registration) settle. */
const flush = async () => {
	for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
//#endregion

const tree = render(Action, { wide: true });
const nodes = collect(tree);
check("action label rendered", true, textsOf(tree).includes("新建子文件夹"));
check("dialog renders its Create button", true, textsOf(tree).includes("创建"));
check("parent selector lists both workspaces", 2, nodes.filter((node) => node.type === "option").length);
check("parent defaults by the active Session cwd", "ws-1", nodes.find((node) => node.type === "select")?.props?.value);
check("name input present", true, nodes.some((node) => node.type === "input"));
// Report calls carry the self-check another process reads; only mkdir work is a
// directory operation, so the assertions below separate the two.
const mkdirCalls = () => routeCalls.filter((call) => call.payload?.action === "mkdir");
const reportStages = () => routeCalls.filter((call) => call.payload?.action === "report").map((call) => call.payload.stage);
check("apply reported that it loaded", true, reportStages().includes("client-applied"));
check("apply reported that the slot was claimed", true, reportStages().includes("slot-registered"));
check("the action reported that it painted", true, reportStages().includes("button-rendered"));
check("no directory work before Create", 0, directoryCalls.length + mkdirCalls().length);

//#region drive Create through the built-in directory capability
collect(tree)
	.find((node) => node.type === "input")
	.props.onChange({ target: { value: " 论文 " } });

const typed = render(Action, { wide: true });
const preview = textsOf(typed).find((value) => value.includes("论文"));
check("path preview uses the platform separator", true, typeof preview === "string" && preview.includes("C:\\work\\parent\\论文"));

const createButton = buttonByLabel(typed, "创建");
check("create button enabled", false, createButton?.props?.disabled);
createButton.props.onClick();
await flush();

check("directory created through the built-in capability", ["C:\\work\\parent|论文"], directoryCalls);
check("workspace registered with the created path", ["C:\\work\\parent\\论文"], created);
check("grouping switched to the workspace tree", ["workspace-tree"], grouped);
check("no fallback route call", 0, mkdirCalls().length);

const settled = render(Action, { wide: true });
const settledTexts = textsOf(settled).join(" | ");
check("success state reports the registration", true, settledTexts.includes("已创建并注册：论文"));
check("done button replaces Create", true, textsOf(settled).includes("完成"));
//#endregion

//#region invalid name keeps Create disabled
frames.clear();
collect(render(Action, { wide: true }))
	.find((node) => node.type === "input")
	.props.onChange({ target: { value: "a/b" } });
const invalidTree = render(Action, { wide: true });
check("separator in the name disables Create", true, buttonByLabel(invalidTree, "创建")?.props?.disabled === true);
check("invalid name explains itself", true, textsOf(invalidTree).some((value) => value.includes("不能包含")));
//#endregion

//#region fallback without the built-in capability
frames.clear();
delete services.uiWorkspace.createDirectory;
created.length = 0;
grouped.length = 0;
directoryCalls.length = 0;

const fallbackInput = collect(render(Action, { wide: true })).find((node) => node.type === "input");
fallbackInput.props.onChange({ target: { value: "deep" } });
const fallbackButton = buttonByLabel(render(Action, { wide: true }), "创建");
fallbackButton.props.onClick();
await flush();

check("fallback route used", 1, mkdirCalls().length);
check("fallback route parent", "C:\\work\\parent", mkdirCalls()[0]?.payload?.parentPath);
check("fallback sends the plugin header", "workspace-subfolder", mkdirCalls()[0]?.headers?.["x-dsh-plugin"]);
check("fallback still registers the Workspace", ["C:\\work\\parent\\deep"], created);
check("fallback still switches the grouping", ["workspace-tree"], grouped);
//#endregion

//#region a native picker that refuses createDirectory falls through to the route
// The composed picker can be the native one, whose createDirectory answers
// "directory-picker/unavailable" — the exact failure a person sees as
// "directory browse failed". It must not reach the dialog.
frames.clear();
created.length = 0;
grouped.length = 0;
const beforeRefusal = routeCalls.length;
services.uiWorkspace.createDirectory = async () => {
	const refused = new Error("directory browse failed: directory-picker/unavailable");
	refused.rpcError = { code: "directory-picker/unavailable", message: "needs the browse capability" };
	throw refused;
};
collect(render(Action, { wide: true }))
	.find((node) => node.type === "input")
	.props.onChange({ target: { value: "refused" } });
buttonByLabel(render(Action, { wide: true }), "创建").props.onClick();
await flush();

const refusedRouteCalls = routeCalls.slice(beforeRefusal).filter((call) => call.payload?.action === "mkdir");
check("a refusing picker falls back to the route", 1, refusedRouteCalls.length);
check("the route still receives the parent", "C:\\work\\parent", refusedRouteCalls[0]?.payload?.parentPath);
check("the refusal still registers the Workspace", true, created.includes("C:\\work\\parent\\refused"));
const afterRefusal = textsOf(render(Action, { wide: true })).join(" | ");
check("the dialog reports success instead of the RPC error", true, afterRefusal.includes("已创建并注册"));
check("the RPC error text is not shown", false, afterRefusal.includes("directory-picker/unavailable"));
//#endregion

//#region a double submit creates exactly once
// React state is not visible to a handler that runs before the next render, so a
// second click or a second Enter must be refused by the in-flight ref.
frames.clear();
created.length = 0;
const beforeDouble = routeCalls.length;
collect(render(Action, { wide: true }))
	.find((node) => node.type === "input")
	.props.onChange({ target: { value: "double" } });
const doubleButton = buttonByLabel(render(Action, { wide: true }), "创建");
doubleButton.props.onClick();
doubleButton.props.onClick();
doubleButton.props.onClick();
await flush();

const doubleMkdir = routeCalls.slice(beforeDouble).filter((call) => call.payload?.action === "mkdir");
check("a triple click issues one mkdir", 1, doubleMkdir.length);
check("a triple click registers one Workspace", 1, created.length);
check("the one name that did run is the typed one", "double", doubleMkdir[0]?.payload?.name);
//#endregion

//#region moving a conversation into another folder
frames.clear();
sessionRefreshes.length = 0;
const beforeMove = routeCalls.length;

render(Action, { wide: true }); // mounts the footer host that owns the move dialog
const menuTree = render(MoveMenuItem, { sessionId: "session-1", displayTitle: "测试会话" });
check("move: the menu entry is labelled", "移动到文件夹…", collect(menuTree).find((node) => typeof node.props?.children === "string")?.props?.children);
menuTree.props.onSelect();

const dialogTree = render(Action, { wide: true });
// The test copy forces the create dialog open, so locate the move dialog by its
// own Modal title instead of counting nodes across the whole tree.
const moveModal = collect(dialogTree).find((node) => node.props?.title === "移动到文件夹");
const moveDialogNodes = moveModal === undefined ? [] : collect(moveModal.props?.children);
const dialogTexts = textsOf(dialogTree);
check("move: the menu opens the dialog", true, moveModal !== undefined);
check("move: it names the conversation", true, dialogTexts.some((value) => value.includes("测试会话")));
check("move: only the other folder is offered", 1, moveDialogNodes.filter((node) => node.type === "option").length);
check("move: the other folder is the offered one", true, dialogTexts.some((value) => value.includes("other") && value.includes("C:\\work\\other")));

const moveButton = buttonByLabel(dialogTree, "移动");
check("move: enabled with a target", false, moveButton?.props?.disabled);
moveButton.props.onClick();
await flush();

const movePosts = routeCalls.slice(beforeMove).filter((call) => call.payload?.action === "move");
check("move: exactly one request", 1, movePosts.length);
check("move: sends the session id", "session-1", movePosts[0]?.payload?.sessionId);
check("move: sends the chosen folder", "C:\\work\\other", movePosts[0]?.payload?.targetPath);
check("move: sends the plugin header", "workspace-subfolder", movePosts[0]?.headers?.["x-dsh-plugin"]);
check("move: the session list is refreshed", true, sessionRefreshes.includes("refresh"));
const afterMove = textsOf(render(Action, { wide: true })).join(" | ");
check("move: success is reported", true, afterMove.includes("已移动"));
check("move: the original location is shown", true, afterMove.includes("C:\\work\\parent"));
//#endregion

//#region renaming a workspace's real directory
// The sidebar's rename only changes the title; this mode changes the directory.
frames.clear();
const beforeRename = routeCalls.length;
sessionRefreshes.length = 0;

const createTree = render(Action, { wide: true });
const renameModeButton = buttonByLabel(createTree, "重命名文件夹");
check("rename: the dialog offers the mode", true, renameModeButton !== undefined);
renameModeButton.props.onClick();

const renameTree = render(Action, { wide: true });
const renameInput = collect(renameTree).find((node) => node.type === "input");
check("rename: starts from the real directory name", "parent", renameInput?.props?.value);
check("rename: the select asks for the workspace", true, textsOf(renameTree).some((value) => value.includes("要重命名的工作区")));

renameInput.props.onChange({ target: { value: "renamed-folder" } });
const typedRenameTree = render(Action, { wide: true });
check("rename: preview shows the resulting path", true, textsOf(typedRenameTree).some((value) => value === "C:\\work\\renamed-folder"));
check("rename: the action is enabled", false, buttonByLabel(typedRenameTree, "重命名")?.props?.disabled);
buttonByLabel(typedRenameTree, "重命名").props.onClick();
await flush();

const renamePosts = routeCalls.slice(beforeRename).filter((call) => call.payload?.action === "rename");
check("rename: exactly one request", 1, renamePosts.length);
check("rename: sends the workspace id", "ws-1", renamePosts[0]?.payload?.workspaceId);
check("rename: sends the new name", "renamed-folder", renamePosts[0]?.payload?.newName);
check("rename: sends the plugin header", "workspace-subfolder", renamePosts[0]?.headers?.["x-dsh-plugin"]);
const afterRename = textsOf(render(Action, { wide: true })).join(" | ");
check("rename: success is reported", true, afterRename.includes("已重命名文件夹"));
check("rename: it says sessions followed", true, afterRename.includes("跟着搬过去的会话"));
check("rename: the session list is refreshed", true, sessionRefreshes.includes("refresh"));
//#endregion

//#region the two conversations a move must refuse
// The one on screen, and one with a turn in flight. Everything else is allowed.
frames.clear();
selectedSessionId = "session-1";
render(Action, { wide: true });
render(MoveMenuItem, { sessionId: "session-1", displayTitle: "测试会话" }).props.onSelect();
const openHereTree = render(Action, { wide: true });
check("move: the conversation on screen cannot move", true, buttonByLabel(openHereTree, "移动")?.props?.disabled === true);
check("move: and it says why", true, textsOf(openHereTree).some((value) => value.includes("正在看的会话")));

selectedSessionId = "session-9";
services.sessions.list.getSnapshot().byId["session-1"].running = true;
frames.clear();
render(Action, { wide: true });
render(MoveMenuItem, { sessionId: "session-1", displayTitle: "测试会话" }).props.onSelect();
const runningTree = render(Action, { wide: true });
check("move: a running conversation cannot move", true, buttonByLabel(runningTree, "移动")?.props?.disabled === true);
check("move: and it says why", true, textsOf(runningTree).some((value) => value.includes("正在运行")));
services.sessions.list.getSnapshot().byId["session-1"].running = false;
//#endregion

//#region without the UI primitives (plain-element fallback, collapsed rail)
frames.clear();
let withoutPrimitives = null;
const primitiveLessRequire = (specifier) => {
	if (specifier === "@deepseek-ai/dsh-client-ui-primitives") throw new Error("primitives unavailable");
	return require_(specifier);
};
globalThis.window.__ModuleLoader__.load = (spec) => {
	withoutPrimitives = spec.factory(primitiveLessRequire);
};
new Function(source)();
withoutPrimitives.apply(ctx);
const PrimitiveLessAction = registered
	.filter((entry) => entry.component !== undefined && entry.spec?.name === "sidebar.footer.action")
	.pop().component;
const railTree = render(PrimitiveLessAction, { wide: false });
const railNodes = collect(railTree);
const railTexts = textsOf(railTree);
check("collapsed rail still renders the label as a title", true, String(railNodes.find((node) => node.type === "button")?.props?.title ?? "").includes("新建子文件夹"));
check("fallback dialog renders plain buttons", true, railTexts.includes("取消") && railTexts.includes("创建"));
check("fallback dialog draws its own overlay", true, railNodes.some((node) => node.props?.style?.position === "fixed"));
//#endregion

//#region the boot contract: the factory must carry its own CommonJS shim
// The module system calls `factory(require)` from a classic script, so reading an
// outer `module` aborts the whole web boot with "module is not defined". This
// reproduces that failure from a shim-less copy, so the check cannot rot.
const shimless = original.replace(/\t\tconst module = \{ exports: \{\} \};\n/, "");
check("the bundle declares its own module shim", true, shimless !== original);
let strippedFactory = null;
globalThis.window.__ModuleLoader__.load = (spec) => {
	strippedFactory = spec.factory;
};
new Function(shimless)();
let strippedError = null;
try {
	strippedFactory(() => ({}));
} catch (error) {
	strippedError = error;
}
check("without the shim the boot fails the same way", "ReferenceError", strippedError?.constructor?.name);
//#endregion

//#region the guard: a load failure must leave the app booting
let guardedFactory = null;
globalThis.window.__ModuleLoader__.load = (spec) => {
	guardedFactory = spec.factory;
};
new Function(source)();
let guardedExports = null;
let guardedFailure = null;
try {
	// A platform module that cannot be resolved is the realistic load failure.
	guardedExports = guardedFactory(() => {
		throw new Error("platform module missing");
	});
} catch (error) {
	guardedFailure = error;
}
check("a load failure never escapes the factory", null, guardedFailure);
check("the failed bundle still exports a plugin shape", true, typeof guardedExports?.apply === "function" && Array.isArray(guardedExports?.inject));
check("the failed bundle still names itself", "workspace-subfolder", guardedExports?.name);
//#endregion

const failed = results.filter((ok) => !ok).length;
console.log(failed === 0 ? "ALL " + results.length + " CHECKS PASSED" : failed + " CHECK(S) FAILED");
process.exitCode = failed === 0 ? 0 : 1;
