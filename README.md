# dsh-llm-probe — 巡检看板 · DeepSeek Harness 插件

把本地「大模型接口可用性巡检」搬进 DSH：侧边栏一个「巡检看板」入口（带状态角标），主区一个全幅面板（原生工具条 + 同源 iframe 看板），并给 agent 提供 4 个巡检工具。

- **装上即用，不需要你另外准备巡检脚本**：引擎（`probe.mjs` / `server.mjs` / `dashboard.html` / `mailer.mjs` / `alert.mjs`）已经内置在 `engine/` 里。
- 首次启动会在 `~/.dsh/llm-probe/` 自动建好数据目录并铺一份模板配置（2 个公开模型 + 空密钥），你只需要填一个 API Key 就能开始巡检；换模型、加密钥、看历史都在看板里做。
- 插件只做三件事：**托管**（拉起 `engine/server.mjs`）、**代理**（`/plugins/llm-probe/dashboard/*` 同源反代）、**暴露**（`llmProbe` 服务 + 4 个工具）。

---

## 1. 安装

没有前置依赖：只要 DSH 支持 bundle 插件，装完就能用。

```powershell
git clone https://github.com/<you>/dsh-llm-probe.git "<任意目录>\dsh-llm-probe"
# 然后让 agent 调用 plugin_manager install_bundle，target 传本插件的绝对路径
#   D:\path\to\dsh-llm-probe
```

装好后打开侧边栏的「巡检看板」，第一次会看到一条提示「还没填 API Key」：

1. 点工具条右侧的「打开 Web UI」（或直接点面板里的看板）→ 切到「密钥」页；
2. 在任意子表填一个能用的 Key（模板已带 `DeepSeek 官方`，`https://api.deepseek.com`）；
3. 回到看板点「立即巡检」，第一轮跑完角标和首页就有数据了。

想换成自己的模型清单：看板「模型」页支持新增/编辑/导入，也可以直接改数据目录里的 `catalog.json`。

### 音频类模型（multipart）要准备素材

有些模型（比如 `qwen2-audio-7b-instruct`）的探测方式不是纯文本，而是 **multipart 上传一段音频**。这类条目在模型页里要配两样东西：

1. `requestType: multipart` + `fileField`（服务端要求的字段名，常见是 `file`）；
2. `uploadedFile`：在模型页点「上传音频」选文件，看板会把它存进 `<数据目录>/media/`，并写回一个相对路径（形如 `media/1750000000000-test.wav`）。

仓库自带一段 8KB 样例音频（`engine/media/sample-audio.wav`），首次启动会被铺到 `<数据目录>/media/sample-audio.wav`，可以直接拿它去配条目、当场试一次，不用先自己录。铺种子只补缺失文件，不会覆盖你已有的素材。

`probe.mjs` 解析这个相对路径时以**数据目录**为根（`PROBE_DATA_DIR`），所以音频文件和配置永远待在一起：

- 迁移到新机器：把 `media/` 一起带走，路径不用改；
- 想换一段音频：重新上传即可，旧文件留在 `media/` 里可以手动删；
- 报错 `音频文件不存在: media/xxx.wav`：说明 `media/` 里没有这个文件（上传失败、或只复制了 json 没复制 `media/`）。

装完你会得到：

| 位置 | 内容 |
| --- | --- |
| 侧边栏 | 「巡检看板」图标（自绘 SVG），右上角状态角标 |
| 主区 | 全幅面板：46px 工具条 + 看板 iframe |
| 工具 | `llm_probe_status`、`llm_probe_run`、`llm_probe_model_detail`、`llm_probe_logs` |
| 服务 | `llmProbe`（`getStatus` / `getModels` / `getModelDetail` / `runProbe` / `getLogs`） |

### 数据放在哪

插件自己不存数据，全部落在 **数据目录**（默认 `~/.dsh/llm-probe/`，Windows 是 `C:\Users\<你>\.dsh\llm-probe\`）：

```
~/.dsh/llm-probe/
├── catalog.json        模型清单（模板：1 个 sheet + 2 个模型）
├── keys.json           各子表的 API Key
├── overrides.json      纳入/排除规则、自定义模型、告警配置、外观偏好
├── out/                巡检结果（status.json / rounds.jsonl / probes.jsonl / probe.log）
└── media/              你上传的音频等测试素材
```

数据目录的解析顺序（**不含任何写死的本机路径**）：

1. `config.dataDir`；
2. 环境变量 `LLM_PROBE_DATA`；
3. `$DSH_HOME/llm-probe`（默认 `~/.dsh/llm-probe`）。

首次启动时 `ensureDataDir()` 只补齐**缺失**的文件：已有 `catalog.json` / `keys.json` / `overrides.json` 就原样保留，绝不覆盖你填过的内容。

配置走 `cordis.patch.yml` 的 `config`，三个键都有默认值：

```yaml
- insert:
    - id: llm-probe
      name: 'dsh-llm-probe'
      config:
        dataDir: ''      # 数据目录；留空时按上面三级解析
        port: 8787       # 内置引擎的端口
        autoStart: true  # 没有健康实例时是否自动拉起
```

> 端口被别的程序占用时，`autoStart` 也拉不起来：面板会显示「巡检服务未连接」并提供重试。改 `port` 后记得同步 `config.port`。
>
> 想沿用旧的一套巡检数据：把旧目录里的 `catalog.json` / `keys.json` / `overrides.json` 和 `out/`、`media/` 复制进数据目录即可（本插件 1.1.0 就是这么迁移的）。

## 2. 开发迭代

- **client 半（`lib/client.js`）**：改完保存即可，DSH 的客户端 bundle 走 HMR，Web 端会重载该插件；若没变化，刷新页面。
- **host 半（`lib/index.js`）**：不会被 HMR 接管，需要「禁用 → 启用」该插件（插件管理器里操作，或让 agent 调 `plugin_manager set_plugin`）让 fiber 重新执行 `apply()`。
- 语法自检：`node --check lib/index.js; node --check lib/client.js`。
- **引擎副本**：`engine/` 下是从「大模型可用性巡检」上游同步来的副本，只打了两处补丁——`server.mjs` 支持 `--data <dir>`（数据目录外置）、`probe.mjs` 的 `resolveMediaPath()` 认 `PROBE_DATA_DIR`。上游脚本改了之后，用新版本覆盖 `engine/` 里的同名文件，再把这两个补丁重打一遍即可（补丁位置：`server.mjs` 顶部 `DATA` 常量与 `OUTDIR/CATALOG/OVERRIDES/KEYS` 默认值、`runProbeNow()` 的 argv、`listen` 前的 `mkdir`；`probe.mjs` 的 `resolveMediaPath`）。
- 调试接口（同源，浏览器里直接开）：

```
/plugins/llm-probe/info          连接状态、端口、数据目录、密钥是否已填、模型数
/plugins/llm-probe/stats         透传引擎的 /api/stats（角标与看板首页同一份）
/plugins/llm-probe/health        健康检查（503 = 上游不可达）
/plugins/llm-probe/appearance    外观跟随模式（GET / POST {mode})
/plugins/llm-probe/dashboard/    看板本体（iframe 用）
```

- 反代会把 HTML 里的 `/api/`、`/media/` 改写到前缀下（`/plugins/llm-probe/dashboard/api/...`），**不要在 `dashboard.html` 里写死插件前缀**，它必须保持能独立打开。
- Host 日志：`ctx.logger`，前缀 `[llm-probe]`（启动、spawn、健康等待、白名单拒绝都会记）。

## 3. 卸载

插件管理器移除 `dsh-llm-probe`（或 `plugin_manager remove_bundle`）。卸载时：

1. `ctx.effect` 的清理函数会 `taskkill /pid <pid> /T /F` 回收**本插件拉起**的 `engine/server.mjs`；
2. 如果 8787 上原本就有一个不由插件托管的实例，插件会复用它、不会去杀它；
3. 侧边栏入口、面板、工具、`<style data-plugin="dsh-llm-probe">` 一并移除。

数据目录（`~/.dsh/llm-probe/`：`catalog.json`、`keys.json`、`overrides.json`、`out/`、`media/`）**不会**被删除——卸载只是拿掉插件，你的模型清单和巡检历史还在，重装后自动接着用。要彻底清空就手动删这个目录。

## 4. 新增皮肤画像

客户端把「皮肤适配」分四层，加一个新皮肤只需要动第 3 层：

1. **令牌采样桥**（`TOKEN_MAP`）：宿主主题令牌 → 面板变量 `--p-*`。新增令牌在这里加一行。
2. **皮肤身份热切换**（`detectSkin`）：识别顺序是
   `data-dsh-maid-atelier` → `data-dsh-orca-link` → `theme.getTheme().id/name` → `documentElement.dataset.skin` → `unknown`。
   新皮肤如果只换主题、不改宿主 DOM，走 `theme.getTheme().id`，无需改代码；如果它像 maid-atelier 那样在 DOM 上打标记，加一条 `hasAttr(...)` 判断。
3. **画像 registry**（`SKIN_PROFILES`）：在 `lib/client.js` 里加一个条目即可：

```js
const SKIN_PROFILES = {
  // ...
  'my-skin': {
    accent: '#7c5cff',       // 品牌色：按钮、选中态、卡片描边
    surfaceAlpha: 0.86,      // 卡片不透明度；有它才会做「半透明 + 背景透出」
    backdropBlur: 8,         // 背景模糊半径（px）
    borderStyle: '1px solid rgba(124,92,255,.3)',
    titleFont: 'serif',      // 可选：看板标题字体
    radius: 10,              // 圆角（px）
    decorations: 'minimal',  // 语义标记，方便后续分流
  },
}
```

4. **透明画布透出**（`buildFrameCss`）：`surfaceAlpha` 存在时会输出 `body{background:transparent}`、卡片 `backdrop-filter` 与 `color-mix(...)`，让宿主背景透进 iframe；圆角统一走 `--p-radius`。

状态语义色（`STATE_COLORS`）**故意不跟皮肤**：深色用 `#3ddc97 / #ff6b6b / #f5c451`，浅色用 `#0f7b4f / #c92a2a / #8a5a00`，保证红绿可用/不可用在任何皮肤下都能分辨、正文对比度 ≥ 4.5:1。

工具条/按钮这层「外壳」不盲信宿主令牌，而是**采样 → 算对比度 → 不达标就换兜底**（`sampleChrome()` + `pickReadable()`）：

- 先按宿主真实底色 `--p-bg-base` 的亮度判定亮/暗（判定不出来才退回 `mode`），再取 `CHROME_FALLBACK.dark|light` 作为基线；
- 每个颜色候选都要过 `contrastRatio(前景, 工具条底色) ≥ 4.5`（描边类 1.15、强调色 1.3），不达标或解析失败（`transparent` / `var()` / alpha<0.6）就用基线色；
- 结果以 `--lp-panel-bg / --lp-bar / --lp-fg / --lp-fg-muted / --lp-border / --lp-border-strong / --lp-accent / --lp-accent-fg` 内联到面板根节点，CSS 里再 `var(--lp-fg, #eceef2)` 兜一层；
- 宿主切换亮暗/皮肤时，`Panel` 里的 MutationObserver 会让配色重算一次，不用刷新。

所以某个第三方皮肤把文字和底色做成一个颜色时，工具条会自己退回深色或浅色基线而不会糊掉。要给它更贴皮肤的颜色，就改 `CHROME_FALLBACK` 里对应的一条（或者让 `sampleChrome()` 采样新令牌）。

面板工具条上的「外观」按钮在三档间循环，并持久化到 `overrides.json` 的 `appearance.mode`：

| 模式 | 行为 |
| --- | --- |
| `auto`（默认） | 令牌 + 皮肤画像全量跟随，透明画布透出宿主背景 |
| `dsn` | 只跟亮/暗，用看板自带的暗色/亮色外观，不套皮肤画像 |
| `classic` | 不注入任何变量，完全是看板本来的样子 |

## 5. 工具清单与权限说明

| 工具 | 副作用 | 权限 | 何时用 |
| --- | --- | --- | --- |
| `llm_probe_status` | 无（只读 `out/status.json`） | 无需审批 | 「现在哪些模型不可用」「巡检结果怎么样」 |
| `llm_probe_run` | **有**：向所有纳入模型发真实请求，产生调用开销 | **必须审批**（`ctx.get('approval').request`，只有 `allowed-once` 才执行） | 用户明确说「跑一轮巡检」 |
| `llm_probe_model_detail` | 无 | 无需审批 | 「某个模型最近延迟怎么样 / 为什么失败」 |
| `llm_probe_logs` | 无 | 无需审批 | 排查失败原因 |

约束与脱敏：

- `llm_probe_run` 幂等：已有巡检在跑时返回 `running=true` 不重复启动；1 分钟内重复触发被节流（`RUN_THROTTLE_MS = 60000`）。审批被拒/取消/不可用时**不执行**，直接返回结果说明。
- 所有错误文本经 `mask()`：`sk-...` 只留后 4 位，`Bearer <token>` 同样打码；单行截断 300 字符（日志 500）。
- 工具结果**不返回** `history` 数组（每轮一条，太长），只给趋势统计（近 30 轮延迟 min/avg/max、TPS 均值）。
- 「打开 Web UI」走 host 白名单：只允许 `http://127.0.0.1:<port>` / `http://localhost:<port>`，其它一律 403 `forbidden_url`；本机用系统默认浏览器打开，不经过插件进程的渲染。

## 6. 常见问题

**面板显示「巡检服务未连接」**
8787 上没有健康实例，且自动拉起失败了。先单独跑 `node "<插件目录>\engine\server.mjs" --port 8787 --data "<数据目录>"` 看报错；端口被占时改 `config.port`。面板上的「重试」会重新探测并再次尝试拉起。

**面板提示「还没填 API Key」**
数据目录里 `keys.json` 的子表都是空的。点「打开 Web UI」→「密钥」页填一个，或直接编辑 `keys.json`（键名要和 `catalog.json` 里的 `sheet` 对上）。填完角标会在 30 秒内自己变过来。

**换了台机器，怎么把巡检数据带过去**
复制整个数据目录（默认 `~/.dsh/llm-probe/`，含 `catalog.json` / `keys.json` / `overrides.json` / `out/` / `media/`）到新机器的同一位置，再装插件即可。或者设 `LLM_PROBE_DATA` 指向你放数据的地方。**`media/` 一定要一起复制**——音频类模型的条目里存的是 `media/xxx.wav` 这种相对路径，少这个目录那些模型会报「音频文件不存在」。

**音频类模型报「音频文件不存在: media/xxx.wav」**
看板「模型」页重新上传一次音频（会落到 `<数据目录>/media/`），或把文件手工放进 `media/` 并保证文件名和条目里配的一致。

**iframe 里看板是空白/数据不动**
先直接访问 `http://127.0.0.1:8787` 确认看板本身正常；再看 `/plugins/llm-probe/health`。若只有面板里空白，多半是反代没生效（host 半改动需要「禁用 → 启用」插件才生效）。

**角标一直不显示**
`ok` 状态本来就不显示数字（设计如此）。角标只在：不可用（红底数字）、巡检中（脉冲点）、数据过期（灰点）、服务离线（空心点）时出现。鼠标悬停有说明文案。

**角标数字和看板首页对不上**
两边都取 `/api/stats` 的 `unavailable`，同一份数据、同一时刻。角标 30s 刷新（页面隐藏时降到 300s），看板 iframe 有自己的刷新节奏，允许几十秒差。

**工具条文字看不清 / 和底色一个颜色**
工具条颜色不是直接拿宿主令牌，而是采样后做对比度校验，不达标自动退回 `CHROME_FALLBACK` 的深/浅基线（见第 4 节）。若某个皮肤下仍然偏弱，调 `lib/client.js` 里 `CHROME_FALLBACK.dark|light` 的 `barBg`/`fg`/`fgMuted`，或提高 `sampleChrome()` 里 `pickReadable(...)` 的最小比值。

**改了 `lib/client.js` 没反应**
确认 Web 端 HMR 已重载该插件；不行就刷新页面。改了 `lib/index.js`（host）必须「禁用 → 启用」。

**卸载后 8787 还在跑**
说明那个实例不是插件拉起的（插件只回收自己 spawn 的子进程）。

**能不能删掉 `out/` 目录？**
可以，但状态、角标、工具都会回到「无数据」。删之前建议先跑一轮。
