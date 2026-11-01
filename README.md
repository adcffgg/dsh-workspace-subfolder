# dsh-workspace-subfolder（工作区子文件夹）

> 插件名：`dsh-workspace-subfolder` · 版本 0.3.3 · 许可 MIT
> 给 DeepSeek Harness 用：侧边栏「新建子文件夹」+ 会话菜单「移动到文件夹…」

在左侧边栏底部加一个 **新建子文件夹** 动作：在一个已注册的工作区目录里真的建出一个子目录，并把它注册成一个新的工作区。因为 DSH 内置的 **视图选项 → 分组方式 → 按工作区树** 会把工作区按"最近的已注册祖先目录"嵌套，新建出来的那个就会显示在父工作区下面——这样一层层往下分，会话就不会全挤在一层里了。

## 安装

这是一个标准的 DSH 插件包：一个 npm 包 + 一份 `cordis.patch.yml`（声明往插件树里插一条），客户端那半由 `dsh.client.platform = "web"` 声明。三种装法，任选一种：

**A. 从 tarball 装（推荐给分享）**

```bash
cd ~/.dsh/profiles/desktop
pnpm add file:/path/to/dsh-workspace-subfolder-0.2.0.tgz
```

然后把 `"dsh-workspace-subfolder"` 加进该文件里的 `dsh.profile.bundles` 数组，重启 App。

**B. 从解压目录装**

把压缩包解到 `~/.dsh/plugins/dsh-workspace-subfolder`，再在 profile 的 `package.json` 里加：

```json
"dependencies": { "dsh-workspace-subfolder": "file:C:/Users/<你>/.dsh/plugins/dsh-workspace-subfolder" }
```

并在 `dsh.profile.bundles` 里加 `"dsh-workspace-subfolder"`，重启 App。

**C. 在 marketplace 里装**

如果包发布到了 npm，直接在 DSH 的插件市场搜 `dsh-workspace-subfolder` 安装即可（`private` 字段要先去掉）。

装好后自检（见文末"自检日志"）：日志里应出现 `client-applied` / `slot-registered` / `button-rendered`，以及宿主的 `host-applied — actions=mkdir,move,report`。

## 用

1. 点侧边栏左下角的 **新建子文件夹**。
2. 选父工作区（默认就是当前会话所在的工作区），输入文件夹名，点 **创建**。
3. 插件会：在磁盘上创建该目录 → 通过 DSH 的工作区接口把它注册成工作区 → 把分组方式切到 **按工作区树**。
4. 之后把会话移到这个新工作区里：在新工作区里新建会话即可；会话归属由它自己的 cwd 决定。

要建更深一层，就再选刚建出来的那个工作区当父级，重复即可。

## 重命名文件夹（改真实目录名）

侧边栏的「重命名」**只改显示名**，磁盘上的目录名不变——所以会出现"显示叫插件、目录还叫论文"，移动会话时自然进的是旧目录。

要点开插件对话框，切到 **重命名文件夹**：

1. 选工作区（下拉里显示的是"标题 — 真实路径"，一眼能看出两者是否一致）；
2. 名称框会**预填磁盘上的真实目录名**；
3. 填新名字 → 重命名。

它会：把真实目录改名 → 把这个工作区里每个会话的日志头 `cwd` 改到新路径、存储目录一起搬 → 更新工作区记录的路径（如果标题原本就等于旧目录名，标题也跟着改）→ 重建索引。

安全措施：

- 工作区里**有正在运行的会话时整次改名会被拒绝**（等它跑完）；空闲但被宿主挂着的会话会自动释放后再动；
- 每个会话的日志**先备份**到 `~/.dsh/backups/workspace-subfolder/`；
- 每一步失败都**回滚**：目录名、会话头、存储位置依次还原；
- 目标目录已存在则直接拒绝。

## 把已有的会话移进文件夹

会话行右侧 **"…" 菜单 → 移动到文件夹…**，选目标工作区，点 **移动**。

这不是"改个标签"，而是真的把会话归属换掉：DSH 里会话属于哪个工作区由它日志头里的 `cwd` 决定，所以插件会

1. 只重写日志**第一帧**里的 `cwd`（其余帧逐字节保留，历史一条不动）；
2. 把会话目录搬到目标工作区的项目目录下；
3. 重建工作区记账（先 detached，重新索引，再 attach 到目标）；
4. 丢掉对应的投影缓存，让侧边栏重新读；
5. **重新拉一次会话列表**（客户端服务的 `refreshList()`），**1.2 秒后再补拉一次**。失败时会 `console.warn`，不再静默。
   （0.3.2 加的是那个"补拉"：宿主在释放会话时会广播 `api-session/removed`，这个推送有可能晚于第一次拉取的应答到达，补拉一次才能把行稳定地放回新工作区下面。）

**移动前一定先备份**原日志到 `~/.dsh/backups/workspace-subfolder/`；如果目录搬迁失败，会把日志回滚成原样。

限制：

- **只有两种情况不能移动**：你**正在看的那个会话**（视图正显示它），和**正在跑的会话**（有回合在飞）。
  宿主里"打开过就一直挂着"的**空闲会话会自动释放**——插件先按官方 session-delete 的做法把它 detach 回持久层、等 500ms 排空写入器，再改文件。以前这里一刀切成"活动就拒绝"，是错的。
- 需要先有可放的目标文件夹（用上面的"新建子文件夹"）。
- 移动后会话的工作目录就是目标文件夹，之后新开的话题在那里运行。

宿主那一半（`move` 动作）只在插件重载时生效：改完插件后按一次右上角刷新按钮，或重启 App。

## 边界

- 只建**一层**，名称里不能有路径分隔符、`..`、Windows 非法字符或保留设备名（CON、NUL 之类）。
- 目录已存在时不会报错，直接注册它（幂等）。
- 同名被文件占用时会拒绝，不会覆盖。
- 删除侧边栏里的工作区分组**不会**删除磁盘目录（这是 DSH 自带行为）。
- 建目录优先走 DSH 自带的目录选择能力（`uiWorkspace.createDirectory`）；**它不存在或拒绝时**（例如当前组合的是系统原生目录选择器，会答 `directory-picker/unavailable`）自动回退到本插件自己的 `POST /api/workspace-subfolder`，所以对话框里不会出现这类 RPC 报错。

## 一个踩过的坑（重要）

客户端 bundle 是**普通脚本**：模块系统只把 `require` 传给工厂函数（`factory(require) → exports`），所以工厂里必须自己写

```js
const module = { exports: {} };
const exports = module.exports;
```

漏了这两行，页面启动时会以 `import failed: module is not defined` 失败，而且**整个 App 都起不来**（列在 bundles 里的客户端条目激活失败会直接中止 web boot）。宿主侧加载正常，所以只有客户端这一半会炸。

`smoketest.mjs` 现在按真实契约执行：用 `new Function(source)()` 在"只有全局变量"的作用域里跑脚本，并且额外用一份删掉 shim 的副本复现这个错误，防止再犯。

## 兼容性（分享前请读）

- 开发与验证环境：**DSH `0.2.1-rc.5`** 桌面版 + 自带 Node **v24.21.0**（Windows）。
- 插件用的是 DSH 的**内部接口**（不是公开 SDK），DSH 升级后可能变化。所有调用都做了**特性检测**，缺什么就降级或明确拒绝，不会静默做错：
  - `uiWorkspace.createDirectory` 不存在或被拒绝 → 走插件自己的宿主路由建目录；
  - `workspaces.create` 不可用 → 目录仍会建出来，但会明确告诉你"注册失败"；
  - `registry.indexHeader` / `sessions.liveEntryFor` / `detachEntered` / `agents.status` 不可用 → 移动/改名会拒绝并说明原因，或退化成"重启后生效"；
  - UI primitives 不可用 → 对话框退化成纯元素，仍然可用。
- **移动 / 改名需要 Node ≥ 23.8**：它们要用 `node:zlib` 的 zstd 支持（DSH 桌面版自带的 Node 24 满足）。更老的 Node 上这两个动作会返回 501 并给出提示，**新建子文件夹照常可用**。
- 宿主侧的错误文案目前是中文；界面是英文时会看到中文报错。

## 文件

- `lib/client.js` — 侧边栏底部动作 + 会话菜单项 + 两个对话框（slot `sidebar.footer.action` / `sidebar.workspaces.session.menu.item`）。
- `lib/index.js` — 宿主侧 `POST /api/workspace-subfolder`（`mkdir` / `move` / `rename` / `report`）。
- `selftest.mjs` — 宿主路由自测：`node selftest.mjs`（63 项：新建、移动、改名三条路径的拒绝/释放/备份/帧保留/回滚/记账顺序）。
- `smoketest.mjs` — 客户端自测：自带一个极小的 React 运行时与桩服务，直接调用组件、点下"创建"/"移动"/"重命名"：`node smoketest.mjs`（74 项）。

## 自检日志

插件会在 `~/.dsh/logs/workspace-subfolder.log` 记三行：

```
client-applied   — 客户端那半加载成功（带版本号，如 `v0.3.2`）
slot-registered  — 座位占上了（footer.action / session.menu.item）
button-rendered  — 按钮真的画出来了（wide = 侧栏展开态）
host-applied     — 宿主那半（重新）加载了，并列出支持的动作（mkdir / move / rename / report）
```

想知道"插件到底有没有加载 / 宿主是不是新版本"时看这个文件，比看界面可靠。只记阶段名与路径，不含会话内容。

两个自测都不需要启动 App。

## 会话归属是怎么定的

DSH 里一个会话属于哪个工作区，由**它日志头里的 `cwd`** 决定（工作区目录必须等于这个 `cwd`）。所以"把会话放进文件夹"不是贴标签，而是真的改归属：

- **新会话**：切到目标工作区里新建，它天生就在里面；
- **已有会话**：用会话行 "…" 菜单里的 **移动到文件夹…**（见上文）：插件会改写它的 `cwd`、把存储目录搬过去、再重建工作区记账。

## 开发者：本机是怎么挂上去的

开发时本目录是以 **junction** 形式挂进 profile 的：

- profile 的 `package.json` → `dependencies` 里加 `"dsh-workspace-subfolder": "file:<本目录的绝对路径>"`
- profile 的 `package.json` → `dsh.profile.bundles` 里加 `"dsh-workspace-subfolder"`
- `node_modules/dsh-workspace-subfolder` 指向本目录

改完代码后，用界面右上角的**刷新按钮**换代码（宿主那一半也靠它重载）；因为是 junction，改文件立即生效，不需要重新安装。

## 更新记录

- **0.3.3** — 分享前清理：移动成功后不再重复调 `refreshProjections`；改名失败时清掉 `.rename-tmp`；更正 0.3.2 的说明（`refreshList()` 确实存在，0.3.2 真正加的是"补拉一次"）；新增「兼容性」一节；自测一并打进包。
- **0.3.2** — 移动/改名后**补拉一次**会话列表：宿主释放会话会广播 `api-session/removed`，浏览器会当场删掉那一行，补拉让它稳定回到新工作区；客户端上报版本号。
- **0.3.1** — 修正「活动会话」判定：宿主保留的空闲会话不再被拒，改为**先 detach 释放再动文件**；只有"正在看的"和"正在跑的"被拒绝，并提前置灰说明。
- **0.3.0** — 新增「重命名文件夹」：改真实目录名，工作区里的会话跟着搬（日志先备份、失败回滚）。
- **0.2.0** — 新增「移动到文件夹」：改会话头 `cwd` + 搬存储 + 重建记账，只重写第一帧。
- **0.1.0** — 「新建子文件夹」：建目录并注册为工作区。
