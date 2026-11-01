/**
 * dsh-workspace-subfolder — client half.
 *
 * Adds one "新建子文件夹 / New subfolder" row to the sidebar foot
 * (slot: sidebar.footer.action). The dialog creates a child directory inside a
 * registered Workspace directory and then registers that directory through the
 * normal Workspace command surface, so the sidebar shows it exactly like an
 * ordinary "Add Workspace" registration. Because the built-in grouping mode
 * "按工作区树" nests Workspaces under their nearest registered ancestor, the new
 * Workspace lands inside its parent — which is the whole point of the plugin.
 *
 * Two capabilities are feature-detected rather than assumed:
 *  - the directory is created through `uiWorkspace.createDirectory` when that
 *    service method exists, and through this plugin's own host route otherwise;
 *  - the grouping mode is switched through the browser view actions when they are
 *    reachable, and the dialog simply states the manual step when they are not.
 */
window.__ModuleLoader__.load({
	id: "dsh-workspace-subfolder",
	factory: (require) => {
		// The bundle is a classic script: the module system calls this factory with
		// `require` alone, so the CommonJS shim has to be declared here exactly as
		// every built-in bundle does. Reading an outer `module` fails the whole web
		// boot with "module is not defined".
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// A factory that throws counts as a failed boot entry and aborts the whole
		// page, so this bundle always materializes: a load-time failure leaves the
		// plugin inert and names itself in the console instead of breaking startup.
		exports.name = "workspace-subfolder";
		exports.inject = [];
		exports.apply = () => {};
		try {
			const load = () => {
			const react = require("react");
			const { jsx: h } = require("react/jsx-runtime");
			let primitives = null;
			try {
				primitives = require("@deepseek-ai/dsh-client-ui-primitives");
			} catch (error) {
				console.warn("[workspace-subfolder] UI primitives unavailable, falling back to plain elements:", error);
			}

			const name = "workspace-subfolder";
			const inject = ["slots"];
			const ROUTE = "/api/workspace-subfolder";
			const PLUGIN = "workspace-subfolder";
			const STYLE_ELEMENT_ID = "dsh-workspace-subfolder-style";
			/** Version reported through the self-check log, so the loaded bundle is identifiable. */
			const VERSION = "0.3.3";
			/**
			 * Delay before the second Session-list pull: the host relays a release as
			 * `api-session/removed` on its own stream, so one can still land after the
			 * first pull answered.
			 */
			const REFRESH_SETTLE_MS = 1200;
			const MAX_NAME_LENGTH = 64;
			const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
			const RESERVED_STEM = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

			let hostCtx = null;

			/**
			 * Record one self-check line through this plugin's own host route. Only a
			 * running page can reach that route, so a line in
			 * ~/.dsh/logs/workspace-subfolder.log is proof that the bundle materialized,
			 * applied and claimed its slot — the check a failed boot cannot give.
			 */
			const report = (stage, detail) => {
				try {
					void fetch(ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json", "x-dsh-plugin": PLUGIN },
						body: JSON.stringify({ action: "report", stage, detail: detail ?? "" }),
					}).catch(() => {});
				} catch {
					/* reporting is a diagnostic; it never belongs in the feature's path */
				}
			};

			/** Prefer the page language; fall back to the browser language. */
			const useChinese = () => {
				const hints = [
					typeof document === "undefined" ? "" : document.documentElement?.lang,
					typeof navigator === "undefined" ? "" : navigator.language,
				];
				return hints.some((hint) => typeof hint === "string" && /^zh/i.test(hint));
			};
			const ZH = useChinese();
			const text = (zh, en) => (ZH ? zh : en);

			const messageOf = (reason) =>
				reason instanceof Error ? reason.message : String(reason ?? "unknown error");

			const samePath = (left, right) => {
				if (typeof left !== "string" || typeof right !== "string") return false;
				const trim = (value) => value.replace(/[\\/]+$/, "");
				return trim(left).toLowerCase() === trim(right).toLowerCase();
			};

			const isWindowsPath = (value) =>
				typeof value === "string" && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\"));

			/** The last path segment (a workspace directory's real name). */
			const baseName = (value) => String(value ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";

			/** The directory containing a path, keeping a drive root's separator. */
			const parentDir = (value) => {
				const trimmed = String(value ?? "").replace(/[\\/]+$/, "");
				const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
				if (at < 0) return "";
				const head = trimmed.slice(0, at);
				return /^[A-Za-z]:$/.test(head) ? head + "\\" : head;
			};

			const joinPath = (parent, segment) => {
				const base = String(parent ?? "").replace(/[\\/]+$/, "");
				const separator = isWindowsPath(base) ? "\\" : "/";
				return base + separator + segment;
			};

			/** Validate one folder name exactly like the host route does. */
			const validateName = (raw) => {
				const value = String(raw ?? "").trim();
				if (value === "") return { error: text("请输入文件夹名称", "Enter a folder name") };
				if (value === "." || value === "..") return { error: text("「.」与「..」不能作为文件夹名称", "\".\" and \"..\" are not folder names") };
				if (value.length > MAX_NAME_LENGTH) return { error: text("文件夹名称不能超过 " + MAX_NAME_LENGTH + " 个字符", "Folder names are limited to " + MAX_NAME_LENGTH + " characters") };
				if (INVALID_CHARS.test(value)) return { error: text('名称不能包含 < > : " / \\ | ? * 等字符', 'Names cannot contain < > : " / \\ | ? *') };
				if (/[ .]$/.test(value)) return { error: text("名称不能以空格或句点结尾", "Names cannot end with a space or a period") };
				if (RESERVED_STEM.test(value)) return { error: text("该名称是 Windows 保留设备名", "That name is a reserved Windows device name") };
				return { value };
			};

			/** Subscribe to a snapshot store (getSnapshot + subscribe) without selectors. */
			function useSnapshot(store) {
				const [snapshot, setSnapshot] = react.useState(() =>
					store !== null && store !== undefined && typeof store.getSnapshot === "function" ? store.getSnapshot() : undefined,
				);
				react.useEffect(() => {
					if (store === null || store === undefined || typeof store.getSnapshot !== "function") return undefined;
					setSnapshot(store.getSnapshot());
					// React treats a returned non-function as an error on unmount, so a
					// store that hands back nothing must not become a cleanup.
					const stop = store.subscribe(() => setSnapshot(store.getSnapshot()));
					return typeof stop === "function" ? stop : undefined;
				}, [store]);
				return snapshot;
			}

			/** The Workspace that owns the Session currently open in the main view, else the first one. */
			function defaultParent(items, sessions, uiWorkspace) {
				try {
					const current = uiWorkspace?.selection?.getSnapshot?.();
					const sessionId = current?.sessionId;
					const cwd = typeof sessionId === "string" ? sessions?.byId?.[sessionId]?.cwd : undefined;
					if (typeof cwd === "string" && cwd !== "") {
						const owner = items.find((item) => samePath(item.path, cwd));
						if (owner !== undefined) return owner.workspaceId;
					}
				} catch (error) {
					console.warn("[workspace-subfolder] could not read the active Workspace:", error);
				}
				return items[0]?.workspaceId;
			}

			/**
			 * Create the child directory through whichever capability is present.
			 *
			 * The composed directory picker is not always the browsing one: a profile
			 * that composes the native picker serves "native", which has no
			 * createDirectory at all and answers "directory-picker/unavailable". Any
			 * refusal therefore falls through to this plugin's own host route instead
			 * of surfacing an RPC error the user cannot act on.
			 */
			async function ensureDirectory(uiWorkspace, parentPath, folderName) {
				const fallbackPath = joinPath(parentPath, folderName);
				if (uiWorkspace !== null && uiWorkspace !== undefined && typeof uiWorkspace.createDirectory === "function") {
					try {
						const created = await uiWorkspace.createDirectory(parentPath, folderName);
						return { path: typeof created === "string" && created !== "" ? created : fallbackPath, existed: false };
					} catch (reason) {
						const code = reason?.rpcError?.code ?? reason?.code;
						if (code === "directory-exists") return { path: fallbackPath, existed: true };
						console.warn("[workspace-subfolder] built-in createDirectory refused, using this plugin's route:", reason?.message ?? reason);
					}
				}
				const response = await fetch(ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json", "x-dsh-plugin": PLUGIN },
					body: JSON.stringify({ action: "mkdir", parentPath, name: folderName }),
				});
				const payload = await response.json().catch(() => ({}));
				if (!response.ok || payload?.ok !== true) {
					throw new Error(payload?.error ?? "HTTP " + response.status);
				}
				return {
					path: typeof payload.path === "string" && payload.path !== "" ? payload.path : fallbackPath,
					existed: payload.existed === true,
				};
			}

			/** Switch the browsing mode to the Workspace tree when the view actions are reachable. */
			function switchToTree(uiWorkspace) {
				try {
					const view = uiWorkspace?.view;
					if (view !== null && view !== undefined && typeof view.setGroupBy === "function") {
						view.setGroupBy("workspace-tree");
						return true;
					}
				} catch (error) {
					console.warn("[workspace-subfolder] could not switch the grouping mode:", error);
				}
				return false;
			}

			/**
			 * The stand-in used when the UI primitives cannot be required. It forwards
			 * only what a DOM button understands, so primitive-only props such as
			 * `variant` never reach the element as unknown attributes.
			 */
			function PlainButton(props) {
				return h("button", {
					type: "button",
					disabled: props?.disabled === true,
					onClick: props?.onClick,
					children: props?.children,
				});
			}

			function installStyles() {
				if (typeof document === "undefined" || document.getElementById(STYLE_ELEMENT_ID) !== null) return;
				const style = document.createElement("style");
				style.id = STYLE_ELEMENT_ID;
				style.textContent =
					".dsh-wsf-action{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;min-width:0;margin:2px 2px 6px;padding:7px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;line-height:22px;text-align:left;cursor:pointer}" +
					".dsh-wsf-action:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
					".dsh-wsf-action:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}" +
					".dsh-wsf-action-label{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}" +
					".dsh-wsf-rail{width:36px;height:36px;justify-content:center;margin:2px auto 6px;padding:0}" +
					".dsh-wsf-body{display:flex;flex-direction:column;gap:12px;min-width:min(440px,72vw)}" +
					".dsh-wsf-modes{display:flex;gap:8px;flex-wrap:wrap}" +
					".dsh-wsf-field{display:flex;flex-direction:column;gap:6px;min-width:0}" +
					".dsh-wsf-label{font-size:12px;color:var(--dsw-alias-label-secondary)}" +
					".dsh-wsf-input{box-sizing:border-box;width:100%;min-width:0;padding:7px 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-button-elevated-fill);color:inherit;font:inherit;outline:none}" +
					".dsh-wsf-input:focus{border-color:var(--dsw-alias-state-business-primary)}" +
					".dsh-wsf-path{font-family:var(--ds-font-family-code);font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);word-break:break-all}" +
					".dsh-wsf-error{font-size:12px;line-height:1.5;white-space:pre-wrap;color:#e5484d}" +
					".dsh-wsf-ok{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary)}" +
					".dsh-wsf-hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}";
				document.head.appendChild(style);
			}

			function SubfolderDialog({ onClose }) {
				const ctx = hostCtx;
				const workspaces = ctx === null ? undefined : ctx.get("workspaces");
				const sessions = ctx === null ? undefined : ctx.get("sessions");
				const uiWorkspace = ctx === null ? undefined : ctx.get("uiWorkspace");
				const workspaceSnapshot = useSnapshot(workspaces?.list);
				const sessionSnapshot = useSnapshot(sessions?.list);
				const items = Array.isArray(workspaceSnapshot?.items) ? workspaceSnapshot.items : [];

				const [parentId, setParentId] = react.useState("");
				// One dialog, two folder operations: add a child folder, or rename the
				// real directory of one (the sidebar's own rename only changes the title).
				const [mode, setMode] = react.useState("create");
				const [draft, setDraft] = react.useState("");
				const [renameDraft, setRenameDraft] = react.useState("");
				const [busy, setBusy] = react.useState(false);
				const [error, setError] = react.useState(null);
				const [result, setResult] = react.useState(null);
				const composing = react.useRef(false);
				const renameTouched = react.useRef(false);
				// Guards a second submit (Enter twice, or Enter plus a click) while the
				// first is still in flight: React state is not visible to a handler that
				// runs before the next render.
				const inFlight = react.useRef(false);

				react.useEffect(() => {
					// Keep the selection valid: the chosen Workspace can disappear while the
					// dialog is open (deleted, or the registry refreshed elsewhere).
					const known = items.some((item) => item.workspaceId === parentId);
					if (!known) setParentId(defaultParent(items, sessionSnapshot, uiWorkspace) ?? "");
				}, [items, parentId, sessionSnapshot, uiWorkspace]);

				const parent = items.find((item) => item.workspaceId === parentId);
				const renaming = mode === "rename";

				// Rename starts from the directory's own name: the sidebar title may already
				// differ from what is on disk, and the directory is what this changes.
				react.useEffect(() => {
					if (!renaming || parent === undefined || renameTouched.current) return;
					setRenameDraft(baseName(parent.path));
				}, [renaming, parent?.workspaceId]);

				const field = renaming ? renameDraft : draft;
				const checked = validateName(field);
				const preview =
					parent === undefined || checked.value === undefined
						? ""
						: renaming
							? joinPath(parentDir(parent.path), checked.value)
							: joinPath(parent.path, checked.value);
				// A refused submit keeps its own message; otherwise the name field reports
				// its validation inline, so the disabled action always has a reason.
				// A turn in flight inside the workspace refuses the rename: rewriting its
				// log under a live run would corrupt it.
				const runningInside =
					renaming &&
					parent !== undefined &&
					Object.values(sessionSnapshot?.byId ?? {}).some(
						(entry) => entry?.running === true && typeof entry.cwd === "string" && samePath(entry.cwd, parent.path),
					);
				const shownError = error !== null ? error : field.trim() === "" ? null : checked.error ?? null;
				const blocked = busy || parent === undefined || checked.error !== undefined || runningInside;
				const setField = (value) => {
					if (renaming) {
						renameTouched.current = true;
						setRenameDraft(value);
					} else {
						setDraft(value);
					}
					setError(null);
				};

				const submit = react.useCallback(async () => {
					if (inFlight.current) return;
					if (parent === undefined) {
						setError(text("请先选择工作区", "Pick a Workspace first"));
						return;
					}
					if (checked.error !== undefined) {
						setError(checked.error);
						return;
					}
					inFlight.current = true;
					setBusy(true);
					setError(null);
					try {
						if (renaming) {
							const payload = await renameFolder(parent.workspaceId, checked.value);
							setResult({ kind: "rename", from: payload.from, to: payload.to, sessions: payload.sessions ?? 0, needsRestart: payload.needsRestart === true });
							console.log("[workspace-subfolder] renamed", payload.from, "->", payload.to);
							// A rename releases every live Session in that workspace too, so the same
							// removed-row relay applies.
							await refreshSessionList(ctx.get("sessions"));
						} else {
							const created = await ensureDirectory(uiWorkspace, parent.path, checked.value);
							let workspace;
							try {
								workspace = await ctx.get("workspaces").create({ path: created.path });
							} catch (reason) {
								throw new Error(text("目录已创建，但注册工作区失败：", "Directory created, but registering the Workspace failed: ") + messageOf(reason));
							}
							const grouped = switchToTree(uiWorkspace);
							setResult({
								kind: "create",
								path: created.path,
								title: workspace?.title ?? checked.value,
								existed: created.existed,
								grouped,
							});
							console.log("[workspace-subfolder] registered", created.path);
						}
					} catch (reason) {
						setError(messageOf(reason));
					} finally {
						inFlight.current = false;
						setBusy(false);
					}
				}, [parent, renaming, checked.error, checked.value, uiWorkspace, ctx]);

				const Modal = primitives?.Modal;
				const Action = primitives?.Button ?? PlainButton;
				const close = () => {
					if (!busy) onClose();
				};

				const body =
					result !== null
						? result.kind === "rename"
							? [
									h("div", { className: "dsh-wsf-ok", key: "ok", children: text("已重命名文件夹", "Folder renamed") }),
									h("div", { className: "dsh-wsf-path", key: "from", children: text("原目录：", "Was: ") + result.from }),
									h("div", { className: "dsh-wsf-path", key: "to", children: text("新目录：", "Now: ") + result.to }),
									result.sessions > 0
										? h("div", { className: "dsh-wsf-hint", key: "sessions", children: text("跟着搬过去的会话：" + result.sessions + " 个（每个都先备份了日志）。", result.sessions + " Session(s) followed the directory; every log was backed up first.") })
										: null,
									result.needsRestart
										? h("div", { className: "dsh-wsf-hint", key: "restart", children: text("目录已经改好；侧边栏如果还显示旧路径，重启一次 App 就会重新索引。", "The directory moved; if the sidebar still shows the old path, one app restart re-indexes it.") })
										: null,
								].filter(Boolean)
							: [
									h("div", { className: "dsh-wsf-ok", key: "ok", children: text("已创建并注册：", "Created and registered: ") + result.title }),
									h("div", { className: "dsh-wsf-path", key: "path", children: result.path }),
									result.existed ? h("div", { className: "dsh-wsf-hint", key: "existed", children: text("该目录本来就存在，已直接注册为工作区。", "The directory already existed; it was registered as-is.") }) : null,
									result.grouped
										? h("div", { className: "dsh-wsf-hint", key: "grouped", children: text("已切到「分组方式 → 按工作区树」，它会显示在父工作区下面。", "Switched to the Workspace tree view, so it now appears under its parent.") })
										: h("div", { className: "dsh-wsf-hint", key: "manual", children: text("如未看到嵌套：打开「视图选项 → 分组方式」选「按工作区树」。", "If it is not nested yet: open View options → Group by → Workspace tree.") }),
								].filter(Boolean)
						: [
								// Two folders operations, one selector: create a child, or rename the
								// real directory of the chosen Workspace.
								h("div", {
									className: "dsh-wsf-modes",
									key: "modes",
									children: [
										h(Action, { key: "create", variant: renaming ? "outline" : "primary", disabled: busy, onClick: () => { setMode("create"); setError(null); }, children: text("新建子文件夹", "New subfolder") }),
										h(Action, { key: "rename", variant: renaming ? "primary" : "outline", disabled: busy, onClick: () => { renameTouched.current = false; setMode("rename"); setError(null); }, children: text("重命名文件夹", "Rename folder") }),
									],
								}),
								h("label", {
									className: "dsh-wsf-field",
									key: "parent",
									children: [
										h("span", { className: "dsh-wsf-label", key: "label", children: renaming ? text("要重命名的工作区", "Workspace to rename") : text("父工作区（在它下面新建子文件夹）", "Parent Workspace (the folder it goes inside)") }),
										h("select", {
											className: "dsh-wsf-input",
											key: "select",
											value: parentId,
											disabled: busy,
											onChange: (event) => {
												renameTouched.current = false;
												setParentId(event.target.value);
												setError(null);
											},
											children: items.map((item) =>
												h("option", { key: item.workspaceId, value: item.workspaceId, children: item.title + "  —  " + item.path }),
											),
										}),
									],
								}),
								h("label", {
									className: "dsh-wsf-field",
									key: "name",
									children: [
										h("span", { className: "dsh-wsf-label", key: "label", children: renaming ? text("新的文件夹名称（会改磁盘上的目录名）", "New folder name (renames the directory)") : text("文件夹名称", "Folder name") }),
										h("input", {
											key: "input",
											className: "dsh-wsf-input",
											value: field,
											"aria-label": text("文件夹名称", "Folder name"),
											placeholder: renaming ? text("例如：插件", "e.g. plugins") : text("例如：论文 / 实验数据", "e.g. papers / experiments"),
											"data-modal-autofocus": true,
											autoComplete: "off",
											spellCheck: false,
											maxLength: MAX_NAME_LENGTH,
											disabled: busy,
											onFocus: (event) => event.target.select(),
											onChange: (event) => setField(event.target.value),
											onCompositionStart: () => {
												composing.current = true;
											},
											onCompositionEnd: () => {
												composing.current = false;
											},
											onKeyDown: (event) => {
												if (event.key === "Enter" && !composing.current) {
													event.preventDefault();
													void submit();
												}
											},
										}),
									],
								}),
								preview === "" ? null : h("div", { className: "dsh-wsf-path", key: "preview", children: preview }),
								runningInside
									? h("div", { className: "dsh-wsf-error", key: "running", role: "alert", children: text("这个工作区里有正在运行的会话：等它跑完再改名。", "A conversation in this workspace is running: rename it once the turn finishes.") })
									: null,
								shownError === null ? null : h("div", { className: "dsh-wsf-error", key: "error", role: "alert", children: shownError }),
								h("div", {
									className: "dsh-wsf-hint",
									key: "hint",
									children: renaming
										? text("会真的把磁盘上的目录改名，并让这个工作区里的会话跟着搬过去（日志先备份）。侧边栏的「重命名」只改显示名，不改目录——所以要目录也变，用这里。", "This renames the directory on disk and moves the Workspace's Sessions with it, backing up their logs first. The sidebar's own rename only changes the title, not the directory.")
										: text("会在磁盘上真的建出这个目录，并把它注册成一个工作区；之后把会话放进它即可。", "This really creates the directory on disk and registers it as its own Workspace; move Sessions into it afterwards."),
								}),
							].filter(Boolean);

				const footer =
					result !== null
						? h(Action, { variant: "primary", onClick: close, children: text("完成", "Done") })
						: h(react.Fragment, {
								children: [
									h(Action, { key: "cancel", variant: "outline", disabled: busy, onClick: close, children: text("取消", "Cancel") }),
									h(Action, {
										key: "submit",
										variant: "primary",
										disabled: blocked,
										onClick: () => void submit(),
										children: busy
											? renaming ? text("正在改名…", "Renaming…") : text("正在创建…", "Creating…")
											: renaming ? text("重命名", "Rename") : text("创建", "Create"),
									}),
								],
							});

				if (typeof Modal === "function") {
					return h(Modal, {
						open: true,
						onClose: close,
						closeLabel: text("关闭", "Close"),
						title: renaming ? text("重命名文件夹", "Rename folder") : text("新建子文件夹", "New subfolder"),
						footer,
						children: h("div", { className: "dsh-wsf-body", children: body }),
					});
				}

				return h("div", {
					style: {
						position: "fixed",
						inset: "0",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						background: "rgba(0,0,0,.45)",
						zIndex: 60,
					},
					children: h("div", {
						style: {
							background: "var(--dsw-alias-bg-elevated,#1f1f1f)",
							color: "var(--dsw-alias-label-primary,#eee)",
							borderRadius: "12px",
							padding: "16px",
							maxWidth: "90vw",
						},
						children: [
							h("h3", { key: "title", style: { margin: "0 0 12px" }, children: renaming ? text("重命名文件夹", "Rename folder") : text("新建子文件夹", "New subfolder") }),
							h("div", { key: "body", className: "dsh-wsf-body", children: body }),
							h("div", { key: "footer", style: { marginTop: "14px", display: "flex", justifyContent: "flex-end", gap: "8px" }, children: footer }),
						],
					}),
				});
			}

			//#region move a conversation into another folder
			/**
			 * A session menu unmounts its items the moment one is chosen, so a dialog
			 * owned by a menu item would disappear with it. The request therefore lives
			 * here, and the always-mounted footer action renders the dialog.
			 */
			let moveRequest = null;
			const moveWatchers = new Set();
			const notifyMove = () => {
				for (const watcher of moveWatchers) watcher();
			};
			const requestMove = (payload) => {
				moveRequest = payload;
				notifyMove();
			};
			const clearMove = () => {
				moveRequest = null;
				notifyMove();
			};
			function useMoveRequest() {
				const [value, setValue] = react.useState(moveRequest);
				react.useEffect(() => {
					const watcher = () => setValue(moveRequest);
					moveWatchers.add(watcher);
					watcher();
					return () => {
						moveWatchers.delete(watcher);
					};
				}, []);
				return value;
			}

			/** Call the host's move action and report what it refused. */
			async function moveSessionTo(sessionId, targetPath) {
				const response = await fetch(ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json", "x-dsh-plugin": PLUGIN },
					body: JSON.stringify({ action: "move", sessionId, targetPath }),
				});
				const payload = await response.json().catch(() => ({}));
				if (!response.ok || payload?.ok !== true) {
					const raw = String(payload?.error ?? "HTTP " + response.status);
					// The page can outrun the host: a newly added action is unknown until the
					// host half is reloaded, and "bad-action: move" is what that looks like.
					if (raw.startsWith("bad-action")) {
						throw new Error(text(
							"宿主还没加载这个插件的新版本：按一下右上角的刷新按钮（或重启 App），再来一次。",
							"The host has not loaded this plugin's newest version yet: press the refresh button in the top-right (or restart the app), then retry.",
						));
					}
					throw new Error(raw);
				}
				return payload;
			}

			/** Rename a Workspace's real directory through the host. */
			async function renameFolder(workspaceId, newName) {
				const response = await fetch(ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json", "x-dsh-plugin": PLUGIN },
					body: JSON.stringify({ action: "rename", workspaceId, newName }),
				});
				const payload = await response.json().catch(() => ({}));
				if (!response.ok || payload?.ok !== true) {
					const raw = String(payload?.error ?? "HTTP " + response.status);
					if (raw.startsWith("bad-action")) {
						throw new Error(text(
							"宿主还没加载这个插件的新版本：按一下右上角的刷新按钮（或重启 App），再来一次。",
							"The host has not loaded this plugin's newest version yet: press the refresh button in the top-right (or restart the app), then retry.",
						));
					}
					throw new Error(raw);
				}
				return payload;
			}

			/**
			 * Re-pull the sidebar's Session list after this plugin released a live Session.
			 *
			 * Releasing is what lets the host rewrite a log at all, and the host relays
			 * the release as `api-session/removed`; the browser drops that row on the spot.
			 * The Session is still stored — only its directory or its `cwd` changed — so the
			 * authoritative list still carries it and one re-pull puts the row back under its
			 * new Workspace. Without this, moved conversations look deleted until the next
			 * app restart.
			 *
			 * The client service publishes this as `refresh()`; `refreshList()` is the manager
			 * method behind it, accepted as a fallback so a service exposing only one of the
			 * two still works. The delayed second pass settles a removal relay that lands
			 * after the first pull answered.
			 */
			async function refreshSessionList(sessions) {
				const pull = sessions?.refresh ?? sessions?.refreshList;
				if (typeof pull !== "function") return;
				const once = async () => {
					try {
						await pull.call(sessions);
					} catch (error) {
						console.warn("[workspace-subfolder] session list refresh failed:", error);
					}
				};
				await once();
				setTimeout(() => {
					void once();
				}, REFRESH_SETTLE_MS);
			}

			function MoveSessionDialog({ request, onClose }) {
				const ctx = hostCtx;
				const workspaces = ctx === null ? undefined : ctx.get("workspaces");
				const sessions = ctx === null ? undefined : ctx.get("sessions");
				const workspaceSnapshot = useSnapshot(workspaces?.list);
				const sessionSnapshot = useSnapshot(sessions?.list);
				const items = Array.isArray(workspaceSnapshot?.items) ? workspaceSnapshot.items : [];
				const cwd = sessionSnapshot?.byId?.[request.sessionId]?.cwd;
				const current = typeof cwd === "string" ? items.find((item) => samePath(item.path, cwd)) : undefined;
				// Moving a conversation into the folder it already lives in is a no-op.
				const candidates = items.filter((item) => current === undefined || item.workspaceId !== current.workspaceId);

				// Two things a move must not do: pull the conversation out from under the
				// view that is showing it, or cut a turn off mid-flight. Idle-but-retained
				// conversations are fine — the host hands those back before touching files.
				const openHere = (() => {
					try {
						const uiWorkspace = ctx === null ? undefined : ctx.get("uiWorkspace");
						return uiWorkspace?.selection?.getSnapshot?.()?.sessionId === request.sessionId;
					} catch {
						return false;
					}
				})();
				const running = sessionSnapshot?.byId?.[request.sessionId]?.running === true;

				const [targetId, setTargetId] = react.useState("");
				const [busy, setBusy] = react.useState(false);
				const [error, setError] = react.useState(null);
				const [done, setDone] = react.useState(null);
				const inFlight = react.useRef(false);

				react.useEffect(() => {
					if (!candidates.some((item) => item.workspaceId === targetId)) {
						setTargetId(candidates[0]?.workspaceId ?? "");
					}
				}, [candidates, targetId]);

				const target = candidates.find((item) => item.workspaceId === targetId);
				const blocked = busy || target === undefined || openHere || running;

				const submit = react.useCallback(async () => {
					if (inFlight.current || target === undefined) return;
					inFlight.current = true;
					setBusy(true);
					setError(null);
					try {
						const payload = await moveSessionTo(request.sessionId, target.path);
						setDone({ title: target.title, payload });
						const live = ctx.get("sessions");
						// Releasing the Session — the host has to, to rewrite its log — makes the host
						// relay `api-session/removed`, so the browser drops that row at once. The
						// Session is still stored, so re-pull the list; without this the moved
						// conversation looks deleted until the next app restart.
						await refreshSessionList(live);
						try {
							await live?.refreshProjections?.(request.sessionId);
						} catch (refreshError) {
							console.warn("[workspace-subfolder] projection reload after a move failed:", refreshError);
						}
					} catch (reason) {
						setError(messageOf(reason));
					} finally {
						inFlight.current = false;
						setBusy(false);
					}
				}, [request.sessionId, target, ctx]);

				const Modal = primitives?.Modal;
				const Action = primitives?.Button ?? PlainButton;
				const close = () => {
					if (!busy) onClose();
				};

				const body =
					done !== null
						? [
								h("div", { className: "dsh-wsf-ok", key: "ok", children: text("已移动：", "Moved: ") + (request.title ?? request.sessionId) }),
								done.payload?.from === undefined ? null : h("div", { className: "dsh-wsf-path", key: "from", children: text("原位置：", "From: ") + done.payload.from }),
								h("div", { className: "dsh-wsf-path", key: "to", children: text("目标：", "Into: ") + (done.payload?.to ?? done.title) }),
								h("div", { className: "dsh-wsf-hint", key: "hint", children: text("它会出现在那个工作区下面；会话的工作目录也随之变成该目录，之后新开的话题就在那里运行。", "It now belongs to that workspace; its working directory follows, so new turns run there.") }),
								done.payload?.needsRestart
									? h("div", { className: "dsh-wsf-hint", key: "restart", children: text("文件已经移动完成；如果侧边栏暂时没换位置，重启一次 App 就会按新归属重新索引。", "The files moved; if the sidebar has not caught up, one app restart re-indexes the placement.") })
									: null,
								done.payload?.backup ? h("div", { className: "dsh-wsf-hint", key: "backup", children: text("原日志备份：", "Original log backup: ") + done.payload.backup }) : null,
							].filter(Boolean)
						: [
								h("div", { className: "dsh-wsf-hint", key: "session", children: text("要移动的会话：", "Conversation: ") + (request.title ?? request.sessionId) }),
								current === undefined
									? null
									: h("div", { className: "dsh-wsf-path", key: "from", children: text("当前位置：", "Currently in: ") + current.path }),
								candidates.length === 0
									? h("div", { className: "dsh-wsf-error", key: "none", children: text("还没有别的工作区可以放它。先在侧边栏建一个子文件夹。", "There is no other Workspace to move it into yet.") })
									: h("label", {
											className: "dsh-wsf-field",
											key: "target",
											children: [
												h("span", { className: "dsh-wsf-label", key: "label", children: text("移动到", "Move into") }),
												h("select", {
													className: "dsh-wsf-input",
													key: "select",
													value: targetId,
													disabled: busy,
													onChange: (event) => {
														setTargetId(event.target.value);
														setError(null);
													},
													children: candidates.map((item) =>
														h("option", { key: item.workspaceId, value: item.workspaceId, children: item.title + "  —  " + item.path }),
													),
												}),
											],
										}),
								openHere
									? h("div", { className: "dsh-wsf-error", key: "open", role: "alert", children: text("这是你正在看的会话：先切到别的会话，再移动它。", "This is the conversation you are viewing: switch to another one first.") })
									: null,
								running
									? h("div", { className: "dsh-wsf-error", key: "running", role: "alert", children: text("这个会话正在运行：等它跑完再移动。", "This conversation is running: move it once the turn finishes.") })
									: null,
								error === null ? null : h("div", { className: "dsh-wsf-error", key: "error", role: "alert", children: error }),
								h("div", { className: "dsh-wsf-hint", key: "hint", children: text("会改写会话日志里的工作目录，并把它的存储搬到目标工作区的目录下；原日志先备份。宿主里挂着的空闲会话会自动释放；只有正在看的、或正在跑的会话不能移动。", "This rewrites the conversation's working directory and moves its storage under the target workspace, backing the log up first. Idle conversations the host still holds are released automatically; only the one you are viewing, or a running turn, is refused.") }),
							].filter(Boolean);

				const footer =
					done !== null
						? h(Action, { variant: "primary", onClick: close, children: text("完成", "Done") })
						: h(react.Fragment, {
								children: [
									h(Action, { key: "cancel", variant: "outline", disabled: busy, onClick: close, children: text("取消", "Cancel") }),
									h(Action, { key: "move", variant: "primary", disabled: blocked, onClick: () => void submit(), children: busy ? text("正在移动…", "Moving…") : text("移动", "Move") }),
								],
							});

				if (typeof Modal === "function") {
					return h(Modal, {
						open: true,
						onClose: close,
						closeLabel: text("关闭", "Close"),
						title: text("移动到文件夹", "Move to a folder"),
						footer,
						children: h("div", { className: "dsh-wsf-body", children: body }),
					});
				}

				return h("div", {
					style: { position: "fixed", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.45)", zIndex: 60 },
					children: h("div", {
						style: { background: "var(--dsw-alias-bg-elevated,#1f1f1f)", color: "var(--dsw-alias-label-primary,#eee)", borderRadius: "12px", padding: "16px", maxWidth: "90vw" },
						children: [
							h("h3", { key: "title", style: { margin: "0 0 12px" }, children: text("移动到文件夹", "Move to a folder") }),
							h("div", { key: "body", className: "dsh-wsf-body", children: body }),
							h("div", { key: "footer", style: { marginTop: "14px", display: "flex", justifyContent: "flex-end", gap: "8px" }, children: footer }),
						],
					}),
				});
			}

			/** The sidebar session-menu entry that starts a move. */
			function MoveSessionMenuItem(props) {
				const sessionId = typeof props?.sessionId === "string" ? props.sessionId : "";
				const title = typeof props?.displayTitle === "string" ? props.displayTitle : "";
				const onSelect = () => {
					if (sessionId === "") return;
					requestMove({ sessionId, title });
				};
				const label = text("移动到文件夹…", "Move to folder…");
				const MenuItemButton = primitives?.MenuItemButton;
				const Icon = primitives?.IconFolderOpenRegular;
				if (typeof MenuItemButton === "function") {
					return h(MenuItemButton, {
						onSelect,
						...(typeof Icon === "function" ? { icon: h(Icon, { size: 14 }) } : {}),
						children: label,
					});
				}
				return h("button", { type: "button", onClick: onSelect, style: { display: "block", width: "100%", padding: "6px 10px", border: 0, background: "transparent", textAlign: "left", cursor: "pointer", color: "inherit", font: "inherit" }, children: label });
			}
			//#endregion

			function SubfolderAction(props) {
				const [open, setOpen] = react.useState(false);
				const isWide = props?.wide !== false;
				// A registered slot is not a painted row: this line is the difference
				// between "the sidebar claimed the entry" and "the button is on screen",
				// which is exactly the check a rebuild cannot give from the outside.
				react.useEffect(() => {
					report("button-rendered", isWide ? "wide" : "rail");
				}, [isWide]);
				const Icon = primitives?.IconProjectAddOutlineRegular ?? primitives?.IconFolderOpenRegular;
				const label = text("新建子文件夹", "New subfolder");
				const description = text("在当前工作区目录下新建文件夹，并注册为子工作区", "Create a folder inside a Workspace directory and register it as its own Workspace");
				const content = [typeof Icon === "function" ? h(Icon, { size: 14, key: "icon" }) : null, isWide ? h("span", { className: "dsh-wsf-action-label", key: "label", children: label }) : null].filter(Boolean);
				const button = h("button", {
					type: "button",
					className: isWide ? "dsh-wsf-action" : "dsh-wsf-action dsh-wsf-rail",
					title: isWide ? description : label + " — " + description,
					"aria-label": label,
					onClick: () => setOpen(true),
					children: content,
				});
				const pendingMove = useMoveRequest();
				return h(react.Fragment, {
					children: [
						button,
						open ? h(SubfolderDialog, { key: "dialog", onClose: () => setOpen(false) }) : null,
						// The session menu cannot own this dialog: it unmounts its items on
						// selection. The footer action is always mounted while rows are visible.
						pendingMove === null ? null : h(MoveSessionDialog, { key: "move", request: pendingMove, onClose: clearMove }),
					],
				});
			}

			function apply(ctx) {
				hostCtx = ctx;
				installStyles();
				report("client-applied", "v" + VERSION + " inject=" + inject.join(","));
				try {
					ctx.slots.inject("sidebar.footer.action", function* () {
						yield ctx.slots.register(
							{ name: "sidebar.footer.action", id: "workspace-subfolder", order: 100 },
							SubfolderAction,
						);
						report("slot-registered", "sidebar.footer.action");
					});
					ctx.slots.inject("sidebar.workspaces.session.menu.item", function* () {
						yield ctx.slots.register(
							{ name: "sidebar.workspaces.session.menu.item", id: "workspace-subfolder-move", order: 850 },
							MoveSessionMenuItem,
						);
						report("slot-registered", "sidebar.workspaces.session.menu.item");
					});
					console.log("[workspace-subfolder] footer action and session menu item registered");
				} catch (error) {
					report("slot-registration-failed", messageOf(error));
					console.warn("[workspace-subfolder] could not register the footer action:", error);
				}
			}

			exports.apply = apply;
			exports.inject = inject;
			exports.name = name;
			};
			load();
		} catch (error) {
			console.error("[workspace-subfolder] disabled after a load failure; the rest of the app keeps booting:", error);
		}
		return module.exports;
	},
});
