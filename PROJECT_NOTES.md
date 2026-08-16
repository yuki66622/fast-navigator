# PROJECT_NOTES.md — Fast Navigator

> 内部笔记：架构、决策、坑、待办。面向发布的介绍见 README。
> 初版 2026-07-24，基于三轮项目设定讨论定稿。

## 0. 公开仓库边界（先读这条）

本公开仓库**只包含**：通用索引内核、合成 MockCRM 演示、MockAdapter、适配器接口与
开发模板、自然语言 sidecar、MCP 工具、Benchmark、Debug Mode 结构探针（通用工具）。

本公开仓库**不包含任何真实网站专用适配器**（selector、域名、页面结构、专用逻辑、
站点结构报告）。真实网站的适配器属于私下技术评估，须遵守目标网站条款、权限与适用法律，
不在此仓库分发。基于本仓库开发自己的站点适配器时，请自行承担合规责任（见第 4 节模板）。

## 1. 项目定位

本地技术原型，验证浏览器 Agent 执行层的两个核心能力：

1. **信息定位速度**：不依赖模型推理，快速在复杂网页中找到并定位目标记录；
2. **状态保存**：已扫描的信息、已处理的进度在刷新/重开后可恢复，避免重复执行。

核心系统是**通用**的（通用内核 + 站点适配器）。公开演示以合成 MockCRM 承载，
它参数化复现四类真实网页难题：动态分批加载、重复导航、SPA 路由、虚拟滚动。

### 版本路线

- **V1**：纯确定性执行层，无 LLM。扫描、索引、搜索、定位、高亮、状态保存。
- V2（已完成 2026-07-25）：LLM 只做「自然语言 → 结构化查询条件」的转换，
  执行仍走确定性内核。实施记录见 9.5。
- V3（已完成 2026-07-25）：内核包装成 MCP server 供 AI Agent 直接调用。实施记录见 9.6。

### 非目标（明确不做）

- 自动发送消息/邮件；
- 绕过机器人检测/人机验证；
- 抓取隐藏数据或绕过站点权限（只处理当前页面已加载、用户可见的信息）；
- 修改页面数据（只读：扫描/定位/高亮，不写值）；
- 自动爬取整站；
- 完整 AI Agent。

## 2. 合规与发布边界

公开仓库（通用内核 + 合成演示 + 接口）设计上不承载任何真实站点数据或专用逻辑。

真实站点适配器仅用于私下技术评估，须遵守目标网站条款与适用法律。**不得提交到任何
公开仓库**：真实数据、账号信息、Cookie、完整页面快照、未经脱敏的 DOM 数据。

Debug Mode 的分析产物如需在私下评估中留存，必须脱敏：保留字段结构与元素特征，
真实值一律替换为占位值；且脱敏后的站点结构报告仍属私有，不进公开仓库。

## 3. 架构

```
side panel UI（内核的第一个客户端）
        |
通用内核 core/（站点无关，可调用的纯函数层）
  索引存储 | 查询引擎 | 状态持久化 | 增量更新
  定位/高亮执行器 | 路由变化监听机制 | 结构健康检查 | Benchmark 打点
        |
适配器接口（唯一允许出现站点知识的边界）
        |
   MockAdapter（对合成 MockCRM）
   [ 你的站点适配器：私有、按接口自行实现 ]
```

扩展骨架（MV3）：

```
manifest.json
background.js        扩展生命周期、side panel 开关
content/             注入页面：内核运行时 + 当前站点适配器
core/                站点无关内核（见上）
adapters/
  registry.js        适配器注册表
  mock/              MockAdapter（合成演示）
  example.template.js  适配器开发模板（见第 4 节）
sidepanel/           搜索、结果列表、状态展示、数据年龄、清空按钮
mock-site/           合成网页（独立目录，可单独起服务）
bench/               Benchmark 脚本与报告生成
debug/               结构探针（Debug Mode，通用只读工具）
tests/
```

### 3.1 硬性架构契约

- **内核不得出现任何站点特有的选择器、字段名、路由规则**。出现即架构违规，评审时按 CRITICAL 处理。
- 内核 API 从第一天起设计为可调用的纯函数层；side panel 只是第一个客户端，
  V3 的 Agent Tool 是同一层的薄壳，不允许出现「UI 里才有的逻辑」。
- 站点结构判断（扫描哪里、什么算一条记录、ID 从哪来）**只存在于适配器**。

### 3.2 适配器接口

```
matches(url, doc)       -> bool     我负责哪些页面
getScanRoots(document)  -> Node[]   当前页面中应被扫描的区域根节点。
                                    扫描边界由适配器划定，内核不做站点结构判断。
extractRecords(root)    -> {records, mode}  DOM -> 结构化记录 + primary/fallback/none
getRecordId(record)     -> string   稳定唯一标识（去重、状态、增量的基石）
scrollToRecord(id)      -> Promise<{ status: "success" | "failure",
                                     mountedTarget?: Element, reason? }>
                                    完成后必须向内核返回明确结果：成功/失败/
                                    当前挂载的目标元素，内核的通用高亮执行器
                                    和 Benchmark 打点依赖这个返回值继续工作。
onRouteChange(url)      -> {view, id?}  内核负责监听机制（hook history API），
                                    适配器负责解释本站路由语义（列表页/详情页/无关页）。
```

记录 ID 策略：MockAdapter 用合成页的显式 ID。真实站点适配器应优先用页面上稳定的
实体 ID（详情链接中的 ID、data 属性），兜底才用语义组合键（有重名风险）。

### 3.3 数据与存储

- **全局本地索引池**（跨扫描累积），每条记录带来源元数据：哪次扫描、所在路由、扫描时间戳。
- **不自动过期**：UI 显示每条数据的年龄，由用户判断新鲜度；提供「清空索引」。
- 存储用 `chrome.storage.local`；索引规模逼近配额再评估迁 IndexedDB，暂不预做。
- 索引与状态不依赖 content script 存活（content script 随导航销毁，数据一律落 storage）。
- **结构异常必须明确报错**：适配器提取结果异常（如扫描根存在但零记录）时，
  内核健康检查上报「页面结构可能已变更」，绝不静默返回空结果。

### 3.4 权限原则

- **最小权限**。优先 `activeTab` + `scripting`（用户主动触发才注入），确有需要才增加站点 host 权限。
- 公开仓库的 manifest **不预置任何真实站点 host 权限**（只有 activeTab/scripting/storage/sidePanel）。
  为真实站点开发适配器时，精确 host 权限须在用 Debug Mode 观察实际环境后自行添加，
  且每一项都要能说出用途。

## 4. 适配器开发（给下载本仓库的人）

按 3.2 的接口实现一个对象并 `AFN.adapters.register(...)`，即可让通用内核为新站点工作，
无需改动内核。起点：

- `extension/adapters/example.template.js` —— 带完整注释的模板，实现全部五个接口方法，
  逐一说明「必须做什么、只读边界在哪、结构变更如何显式报错」。复制它，填入你自己站点的
  选择器与字段映射。
- `extension/adapters/mock/adapter.js` —— MockAdapter 是一个可运行的真实例子
  （primary + fallback 双提取、虚拟列表定位驱动），可对照学习。
- `debug/` —— Debug Mode 结构探针：在目标站点的 DevTools 控制台里只读分析页面结构，
  输出脱敏报告帮你确定选择器、记录 ID、扫描根。用法见 debug/README.md。

模板与 MockAdapter 中不含任何真实站点的 selector、域名或页面结构——那些由你按目标站点
和其条款自行补齐。

## 5. 合成网页规格（MockCRM）

合成页不是简化演示页，而是**参数化复现**四类真实难题，三重用途：
开发测试床、Benchmark 环境、公开演示。

| 难题 | 模拟方式 | 可调参数 |
| --- | --- | --- |
| 虚拟滚动 | 列表只挂载视口附近的行，滚出即卸载 | 总行数、行高、缓冲区行数 |
| 动态分批加载 | 滚动/翻页触发追加数据 | 批量大小、模拟网络延迟 |
| SPA 路由 | 无刷新切换列表页/详情页（history API） | — |
| 结构变更 | 开关：切换后 class 名/DOM 层级改变（v1/v2/v3） | 变更幅度 |

- 每条合成记录带显式稳定 ID（`data-*`），字段仿联系人场景：姓名、公司、职位、地点（全部为生成的假数据）。
- 数据规模分档可调（用于 Benchmark 横向对比）。
- 合成页零依赖、可离线起本地服务。

## 6. Benchmark 方案

### 公平性原则（硬约束）

- baseline 与优化版本必须**完成同等任务**、使用**相同的已加载或已访问数据范围**、**定位相同目标**。
- 虚拟列表中未挂载的记录**不得描述为「全量 DOM 可读」**——baseline 能读到的只有当前挂载的行，
  对比范围以双方实际可访问的数据为准。
- 所有指标由内核统一打点，报告标注数据规模与参数档位。

### 四个分项

| 分项 | baseline | 优化版本 |
| --- | --- | --- |
| 1. 已建索引后的查询性能 | 对相同已访问数据，每次查询全量重读当前挂载 DOM + 文本查找 | 本地索引查询 |
| 2. 目标记录的页面定位性能 | 重新查找 + 滚动到相同目标 | 索引 ID -> `scrollToRecord` -> 高亮 |
| 3. 增量更新 | 新增一批记录后全量重扫 | 只索引新增记录 |
| 4. 刷新后的状态恢复 | 重新扫描重建 | 从 storage 恢复索引与进度 |

辅助指标：冷扫描耗时（每批 N 条）、缓存命中率（查询无需重扫即命中索引的比例）。

## 7. 已知风险与坑

- **虚拟滚动是实现成本集中点**：目标行可能不在 DOM 中，`scrollToRecord` 需驱动列表容器滚动、
  等待目标挂载（MutationObserver/轮询）、再交还内核高亮，全程异步且可能失败——接口里的
  明确返回值就是为此设计的。
- **选择器脆弱性**：真实站点 class 名多为构建哈希，随发版变化。适配器应锚定稳定特征
  （`data-*`、aria role、文本标签、结构模式），配合内核健康检查显式报「结构已变更」。
- **SPA 路由**：站内跳转不触发页面加载。内核 hook history API（pushState/replaceState/popstate）
  统一发路由事件，适配器解释语义；合成页专门测这条。
- **无头/后台验证的坑**：后台标签页 rAF 被节流，滚动/动画类验证不能只信截图，
  要直接读内核状态断言。
- **content script 生命周期**：一切需要跨导航存活的数据落 `chrome.storage.local`，
  content script 只做无状态运行时。

## 8. 待办与开放问题

- [x] M1：合成页（四难题参数化）+ 通用内核 + MockAdapter + side panel
- [x] M1：测试覆盖（扫描/归并/定位/恢复/健康检查）
- [x] M2：Benchmark 四分项 + 报告——双档位全绿，bench/results/latest.md
- [x] V2：自然语言 → 结构化查询（sidecar + 查询引擎 + 面板）
- [x] V3：MCP server（内核成为 Agent Tool）
- [x] 适配器开发模板（example.template.js）+ Debug Mode 探针（通用）
- [ ] 手动验证 activeTab 注入路径（用户按 9 节步骤在合成页双击实测）
- 真实站点适配器：私下评估，不在公开仓库范围内

## 9. M1 实施记录（2026-07-25）

### 目录落地

```
extension/           MV3 扩展（manifest/background/content/core/adapters/sidepanel）
mock-site/           合成网页（零依赖，python3 -m http.server 即可跑）
tests/unit/          node:test 单元测试（纯逻辑）
tests/integration/   node:test + playwright-core，真 Chromium
```

### 契约在实现期的三处修订（均不泄漏站点知识进内核）

1. `matches(url, doc)`：增加 doc 参数——MockAdapter 靠
   `<meta name="application-name" content="MockCRM">` 识别页面，比 URL 模式健壮。
2. `extractRecords(root)` 返回 `{records, mode}`，mode ∈ primary/fallback/none，
   供健康检查区分「主选择器命中 / 降级提取 / 全失效」。
3. `onRouteChange(url)` 返回语义对象（如 `{view:"list"|"detail", id?}`）而非 void，
   记录的 `source.route` 由此填充。

### 已验证的测试覆盖

- 单元（node:test，纯逻辑）：merge 去重/增量/状态保留/纯函数性、查询 AND 匹配与状态过滤、
  健康检查规则矩阵、路由去重、数据生成器确定性、scanner 并发排队。
- 集成（真 Chromium + 真合成页）：A 分批加载下索引池累积且单次扫描为部分扫描；
  B 定位未挂载记录（适配器驱动虚拟滚动直至挂载并高亮，数据穷尽/非法 ID 显式失败）；
  C 静默 pushState 被感知、路由往返后索引完好；D v2 降级提取字段正确 + warning，
  v3 显式 structure-changed error 且不静默返回空。
- 扩展冒烟（真加载 MV3 扩展）：side panel 渲染/搜索/状态流转/清空，走真 chrome.storage。

### 未自动化、需手动验证的路径

工具栏点击 → activeTab 授权 → 注入 → 面板联动（Playwright 点不到工具栏）。手动步骤：
`chrome://extensions` 开发者模式 → 加载已解压 `extension/` → 起合成页
（`npm run mock-site` → http://localhost:8765）→ 页面上点扩展图标 → 面板出现且有数据、
点结果行页面滚动高亮。

### 新踩的坑

- **正式版 Chrome 137+ 移除了 `--load-extension`**（静默忽略，不报错）。自动化测扩展必须用
  Playwright 自带 Chromium：`npx playwright-core install chromium`，launch 时
  `channel: "chromium"`（完整构建 + 新 headless 才支持扩展；默认 headless 走
  headless-shell，不支持扩展）。
- **Playwright `waitForFunction` 不 await async 谓词**——async 函数返回的 Promise 被当真值，
  立即通过。等待条件必须是同步表达式；本项目在测试 harness 里维护同步 stats 镜像。
- **Node 24 `node --test <目录>` 会把目录当模块加载而报错**，要用 glob：
  `node --test "tests/unit/*.test.js"`。
- **MutationObserver + debounce 在持续滚动期间会饿死扫描**（每次 mutation 重置计时器）。
  测试里模拟真人「滚动-停顿」节奏；产品行为上可接受（停下来才扫）。

## 9.2 M2 实施记录（2026-07-25）

`bench/run.js`（Node 驱动，复用 tests/integration/helpers 的服务器/启动/harness）+
`bench/page-fns.js`（页面侧基准函数）。`npm run bench`（双档位）/ `npm run bench:quick`。
结果落 `bench/results/<时间戳>.json` + `bench/results/latest.md`。

### 关键数字（Chromium 149，M 系 mac，delay=30ms，见 latest.md）

2000 条档位：查询 5.3s → ~2ms（~3000×）；定位（远端目标）4.8s → 62ms（77×）；
增量更新 6.0s/2000 行 → 0.67s/~200 行（9×）；刷新恢复 6.3s → 1.3ms。
500 条档位同构，比值按规模缩小。优化侧定位耗时是 settle 等待（双 rAF+30ms）主导的
常数 ~62ms，与目标远近无关——这正是索引+几何跳转的意义。

### 方法要点（公平性如何落实）

- baseline 与优化版同任务同数据范围同目标；**每条查询的结果集逐 id 交叉比对**、
  增量更新做"知识等价"检查（delta 后索引 ≥ 重扫所见行数）、恢复后记录数比对；
  任何一项不合即 exit 1，报告标注不可信。
- 未挂载虚拟行绝不计入"可读 DOM"：任何变体只能读到自己真实挂载过的行。
  "只搜当前挂载行"的廉价变体单独列出，报告其**完整率**（0-3%）而不是把它当对等 baseline。
- baseline 免费复用适配器的提取逻辑（真实 Agent 每行还要付理解成本），比值因此偏保守。
- 测量期间关闭 MutationObserver（harness observe:false），扫描只由驱动器显式触发，
  不污染 baseline 计时。
- 恢复分项的优化侧用 localStorage 读取近似 chrome.storage.local（真实扩展多几 ms IPC），
  报告已注明；baseline 侧如实包含分批加载的网络延迟。

### 新踩的坑

- **sweep 扫到列表底部会误触发下一批加载**，让 baseline 与索引的数据范围漂移——首跑
  4 项交叉校验全部报警（校验体系立功）。修法：合成页加 `manual=1` 参数，批次只能由
  `__MOCK_SITE__.loadNextBatch()` 显式触发，benchmark 下数据到达完全受控；
  滚动触发模式保持默认，集成测试不受影响。
- reload 会重置 harness 计数器，dedup 等聚合指标必须在 reload 前采集。

## 9.3 Debug Mode 结构探针（通用工具，2026-07-25）

`debug/structure-probe.js`：只读、脱敏的页面结构分析工具，帮开发者为**任意**目标站点
确定选择器、记录 ID、扫描根。只报结构（重复行组、属性名、id/href 值的**模式**、
虚拟化信号、滚动容器），绝不采集真实姓名/邮箱/Cookie/原始 DOM 文本：所有文本按字母/
数字脱敏，属性值里的 uuid/hex/数字串 token 化，URL 深层路径段涂抹（姓名 slug 不外泄）。

脱敏函数有单测（tests/unit/probe.test.js），整探针对合成站数据集做过泄漏自检零命中。
`debug/probe-console-snippet.js` 是一键粘贴版（DevTools 控制台运行，脱敏 JSON 进剪贴板）。

用它为真实站点开发适配器时，产出的脱敏报告属于你的私有评估材料，**不入公开仓库**
（见第 0、2 节）。

## 9.5 V2 实施记录（2026-07-25）

自然语言 → 结构化查询。三个部件：

- **查询引擎扩展**（core/query.js，纯函数）：`structured = { all: [{anyOf, field?}], none: [] }`
  ——组内 OR（同义词）、组间 AND、排除词、字段限定；与文本 token、状态过滤 AND 组合；
  非法片段静默忽略不抛错。这层是确定性的，LLM 只产出这份纯数据。
- **LLM sidecar**（sidecar/server.py，本地 Python）：`POST /v1/parse-query {query, fields}`。
  **密钥不进浏览器**是这个形态的决定因素——key 在 `.env`（600 + gitignore），
  面板只发查询文本 + 字段**名**，索引数据零外发。只绑 127.0.0.1；CORS 放行扩展页
  （含 Private Network Access 预检头）。mock 模式（无 key/占位 key/MOCK_LLM=1 自动启用）
  是确定性规则转换器，含中文关键词映射；真实模式 OpenRouter + few-shot + 受约束 JSON
  + 服务端 clamp（组数/词数/长度/字段白名单），LLM 失败自动降级 mock 并在响应标注。
  **偏离惯例记录**：没用 openai SDK，用 stdlib urllib 直调 REST——换来整个 sidecar
  零 pip 依赖（mock 与真实模式皆然），本地原型里这比 SDK 便利更值钱。
- **面板**：NL 输入 → 派生查询以可读形式展示（`(founder | co-founder) @role AND
  (berlin) @location [mock]`）并可一键清除——用户始终能看到实际执行的是什么，
  这是「LLM 不进热路径」的 UI 体现。sidecar 地址可经 `afn:settings.sidecarUrl`
  覆盖（测试用随机端口）；sidecar 不可达时明确提示启动命令，列表不受影响。

测试：结构化查询单测 5 项、sidecar 契约 6 项（mock 模式、含中文/CORS/400）、
面板 E2E 2 项（NL 过滤 + 清除恢复、sidecar 宕机降级）。

**真实 LLM 模式已验证（2026-07-25，用户提供 key 后）**：`mode: llm`，deepseek-chat。
三条验证查询全部高质量（英文角色+行业+地点、双重否定、中文），字段限定用得比 mock 好。
三次调用成本约 $0.0006（估算：每次 ~350 token 入 + ~80 token 出）。

## 9.6 V3 实施记录（2026-07-25）

内核成为 Agent Tool，走 MCP（stdio，newline-delimited JSON-RPC）：

- **sidecar/mcp_server.py**（零依赖延续）：MCP 协议层（initialize / tools/list /
  tools/call / ping）+ 面板 HTTP 桥（127.0.0.1，长轮询 pull / result / status）。
  Agent host 用 `claude mcp add fast-navigator -- python3 <绝对路径>/sidecar/mcp_server.py`
  即挂。面板未连接时 tools/call **快速失败**并给出提示（打开面板、勾 Agent），不挂起；
  调用超时 30s 可配。
- **面板 = 桥接客户端与执行宿主**：Agent 开关（**默认关**，persisted 到
  afn:settings.agentBridge），长轮询循环，白名单执行器。每次 Agent 调用在面板
  showNotice 可见，footer 显示 agent: connected/off——Agent 做了什么用户全程可见。
- **六个工具**：search_records（文本+结构化+状态过滤）、locate_record、
  get_index_stats、set_record_status、rescan_page、parse_query（转发 8787 sidecar）。
  页面副作用只有滚动+高亮+重扫；数据不出本机（Agent host 也在本地）。
- **实测延迟**（E2E，MCP client→stdio→桥→面板→引擎→返回全链路）：冷 52ms、
  热 2ms。对照 M2 baseline（Agent 重读页面 5.3s/查询），这就是当初立项的那个数量级差。

测试：协议契约 4 项（六工具 schema、无面板快速失败、未知工具 JSON-RPC error、
假面板回环 <3s）+ 真实面板 E2E 4 项（stats/搜索文本+结构化/状态写入落 storage/
三类错误路径干净返回）。

**边界如实说明**：locate_record 的成功路径在 E2E 里没验（activeTab 注入无法自动化，
E2E 只验了「content script 未激活」错误路径）；定位逻辑本身由适配器层测试覆盖。

## 9.7 页面动作执行层（V4，2026-07-25）

项目重心从「网页列表索引工具」调整为「浏览器 Agent 的确定性页面执行层」——索引/搜索/
定位保留为辅助能力，核心变成：Agent 不靠视觉找坐标、慢移光标，而是通过已验证的 DOM
元素直接执行动作（进入 People、读员工规模、打开联系人、展开 Contact information、
点击 Access email、读取真实邮箱）。

- **通用内核 `core/actions.js`（站点无关）**：`runAction({adapter, name, args, doc, ...})`。
  内核统一强制：校验 adapter 是否负责当前 URL（否则 `wrong-page`）；把元素解析到**唯一
  可见节点**（0→`not-found`，>1→`ambiguous`，停下不猜）；每次点击后**等待明确完成条件**
  （路由变化 / DOM mutation / 目标文本出现），绝不「点完即认为成功」；登录/验证码/权限墙
  →`blocked`（停下报告，绝不绕过）；结构锚缺失→`structure-changed`；硬超时→`timeout`；
  每次返回 `{ok, status, result, reason, detail, ms, trace}`，trace 是可见的逐步动作轨迹。
  内核里没有任何选择器或页面文案。
- **动作在适配器**：`adapter.actions[name]` 用内核提供的 helper（unique / requireAnchor /
  click / waitFor / waitForRoute）表达站点逻辑；`adapter.detectBlockers(doc)` 声明拦截墙；
  `adapter.isScannable(doc)` 让多视图站点的非列表页处于 idle 而非误报结构变更。
- **合成流程页 `mock-site/flow.html`**（公开演示，假数据）：Company → People → 联系人列表
  → 详情 → Contact information → Access email → 邮箱出现。参数开关复现歧义（`?dup=1`）、
  结构变更（`?broken=1`）、额度限制（`?limit=1`，不揭示邮箱）、揭示延迟（`?revealDelay`）。
  **不含任何真实站点结构**。
- **消息链路**：MCP `run_page_action{action,args,timeoutMs}` / `list_page_actions`
  → mcp_server.py 桥 → side panel 长轮询执行器 → `chrome.tabs.sendMessage` `afn:action`
  → content `runtime.js` → `AFN.actions.runAction` → 当前标签页 DOM，结果原路返回。
  面板底部 **Agent 活动日志**逐条显示动作名 / 结果 / 耗时。
- **不猜邮箱硬保证**：reveal 类动作只返回 DOM 里真实出现的邮箱（排除打码 `****@****.com`），
  额度/权限墙→`reveal-failed`，从不生成或推导。
- **角色优先级 Founder→CEO→Talent→HR**：用 V2 的字段限定查询（`{anyOf,field:"role"}`）做
  确定性 role 匹配，或 `open_people` 返回的 role 字段，不用无界全文 substring。

测试（公开）：`tests/unit/actions.test.js` 10 项（路由/wrong-page/unknown/ambiguous/
not-found/structure-changed/blocked/click-wait-trace/timeout/listActions）+
`tests/integration/flow-actions.test.js` 8 项（真 Chromium 全链路 + 歧义 + 结构变更 +
不猜邮箱 + 等待 DOM + 超时 + wrong-page）。公开全量 75 项（44+31）全绿。

真实站点动作适配器（进入人员列表 / 读员工规模 / 打开联系人 / 展开联系方式 /
点击揭示邮箱等实现）与其页面结构、selector **只在本地私有目录**，不进公开仓库；
私有适配器套用同一 `core/actions.js` 契约，本地有独立测试。

## 10. 决策记录

- 2026-07-24 定位确认：本地技术原型，验证 Agent 执行层的定位速度与状态保存；
  核心系统通用；公开演示走合成页。
- 2026-07-24 四条修正（用户拍板）：
  1. 合规表述为「隔离并显著降低风险」而非「风险消失」；公开仓库以内核/MockAdapter/
     合成页/测试/Benchmark 为主；真实站点适配器私下评估，敏感数据不入库；
  2. 适配器契约增加 `getScanRoots`（扫描边界归适配器）；`scrollToRecord` 必须返回
     明确的成功/失败/挂载目标；
  3. Benchmark 公平性硬约束：同等任务、相同数据范围、相同目标；未挂载虚拟行
     不算「可读 DOM」；拆四分项；
  4. host 权限不预先写死，Debug Mode 后确定；优先 activeTab + scripting。
- 2026-07-24 其余确认：内核/适配器硬契约；内核零站点知识；合成页三重用途；
  开发顺序（合成页先行）；全局索引 + 时间戳；不自动过期 + 可清空；chrome.storage.local；
  结构异常显式报错。
- 2026-07-25 公开边界收敛（用户拍板，选项 A）：真实站点专用适配器与其结构报告
  从公开仓库移出，转入本地私有评估；公开仓库只保留通用内核、合成 MockCRM、
  适配器接口与开发模板。README/PROJECT_NOTES 明示此边界。
```
