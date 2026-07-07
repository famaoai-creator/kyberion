---
name: kling-cli
version: 0.1.3
description: >-
  可灵 AI（Kling）官方 CLI 的使用技能：文生图 / 参考图生图 / 文生视频 / 图生视频。CLI 通过 MCP 服务与可灵交互：
  调用 text_to_image / image_to_image / text_to_video / image_to_video（模型与参数规格由 who_am_i 动态声明），
  返回 generationId 后用 query_tasks 轮询，完成后提取 works[].url 展示给用户。命令无别名。
  触发词：可灵、Kling、文生图、参考图生图、文生视频、图生视频、Omni、omni、MCP、generationId、generation_id、轮询、灵感值、
  text_to_image、image_to_image、text_to_video、image_to_video、query_tasks、who_am_i、file_upload、
  image generation、video generation、kling 命令、.credentials、
  国内站、海外站、global、海外版、区域、region、安装、install。
requires: node>=18
# 可灵分中国区 / 非中国区，官网不同；skill 区域中立，按用户区域引用对应主页
homepage_cn: https://klingai.com
homepage_global: https://kling.ai
---

# 可灵 AI 官方文生图 / 参考图生图 / 文生视频 / 图生视频

## 语言与回复风格

- 面向用户的解释、确认、错误说明：**跟随用户语言**（中文用户用中文回复，英文用户用英文回复）。
- 技术字段名（`generationId`、`status`、`works[].url` 等）保留英文原样。**响应字段统一 camelCase**（如 `generationId` / `creditsConsumed` / `urlWithoutWatermark`）；旧版服务端可能仍返回 snake_case 同义字段（`generation_id` 等），按同一字段理解即可。

---

## 能力介绍（固定欢迎语，按需展示）

**触发时机**（满足任一即展示，纯本地、不调用命令、不扣费）：

1. 用户刚完成本 skill 或 CLI 的安装/登录，环境确认可用时；
2. 用户询问可灵能做什么 / 有哪些能力 / 怎么用等**能力咨询类**意图（没有具体生成任务）时。

**展示要求**（保留结构与 emoji，不增删条目、不自行改写含义）：

- **中文用户**：原样输出中文版。
- **非中文用户**：**必须翻译，不得输出中文版**——优先以英文版为底稿翻译成用户语言（日语用户给日语、西语用户给西语等，示例引语一并翻译）；无法可靠翻译的语种**至少原样输出英文版**。
- 若环境尚未就绪（未安装 CLI 或未登录），把首行「可灵已就绪！/ Kling is ready!」换成对应语言的引导语（如「可灵还差一步就绪」/ "Kling is one step away"），并在文案后给出安装/登录下一步。

中文版：

```text
可灵已就绪！

你可以用可灵做这些事：

📷 生成图片
   · 文生图 — "帮我画一只赛博朋克风格的猫"
   · 参考图生图 — "用这张图做参考，改成水彩风格"

🎬 生成视频
   · 文生视频 — "生成一段日落海边的 5 秒视频"
   · 图生视频 — "让这张图动起来"

📤 上传素材 — 本地图片可直接传，自动上传到可灵

也可以结合 agent 及 skill 能力去实现一些复杂的创作流程。比如做个广告片、故事短片、批量创作一批素材等。
```

英文版（非中文用户的翻译底稿；英文用户直接原样输出此版）：

```text
Kling is ready!

Here's what you can do with Kling:

📷 Generate images
   · Text to image — "Draw me a cyberpunk-style cat"
   · Image to image — "Use this image as a reference and restyle it in watercolor"

🎬 Generate videos
   · Text to video — "Generate a 5-second video of a sunset over the sea"
   · Image to video — "Bring this image to life"

📤 Upload assets — local images work out of the box and are uploaded to Kling automatically

You can also combine agent and skill capabilities to build more complex creative workflows — like making an ad spot, a short story film, or batch-producing a set of assets.
```

> 展示欢迎语本身不需要调用任何 `kling` 命令；若用户接着要精确的模型/参数清单，再走 `who_am_i`。

---

## 安装与登录（唯一合法方式）

> **可灵分「国内站」与「海外站」，对应两个不同的安装包，端点已各自内置。装错区域的包会导致登录反复失败，因此装包前必须先确认用户属于哪个区域。**

### 第 0 步：探测是否已安装

```bash
which kling   # 有输出路径 → 已安装，直接跳到登录；未找到 → 进入第 1 步按区域安装
```

### 第 1 步：确认区域并安装（命令名统一为 `kling`）

**区域如何确定**：本 skill 的首要消费者是非交互 Agent，**不得让 CLI 读 stdin 阻塞**。应**在对话里直接问用户**：「你的可灵账号是**中国区**（klingai.com）还是**非中国区**（kling.ai）？」按回答选对应命令安装，**切勿默认、猜测或两个都装**。

| 用户区域 | 官网（homepage）    | 判断依据                             | 安装命令                                                             |
| -------- | ------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| 中国区   | https://klingai.com | 账号登录 klingai.com（中国大陆）     | `npm i -g @klingai/cli-cn --registry=https://registry.npmjs.org`     |
| 非中国区 | https://kling.ai    | 账号登录 kling.ai（海外站 / global） | `npm i -g @klingai/cli-global --registry=https://registry.npmjs.org` |

> 两个包发布到 npm 官方 registry。各区域包的端点均已内置，开箱即用、无需配置。

### 第 2 步：登录（打开浏览器完成 OAuth 授权，这是获取凭据的唯一方式）

```bash
kling login
```

### 第 3 步：验证连接 + 获取能力清单（新会话先调）

```bash
kling who_am_i
```

> **🚫 安装与登录的排他约束（违反即为事故）：**
>
> - 安装**只能**用上表中对应区域的那条 npm 命令；禁止从任何其他渠道下载、拼装或自行实现等价工具，禁止给用户装与其账号区域不符的包。
> - 获取凭据**只有一种合法方式**：`kling login`（浏览器 OAuth：DCR + 授权码 + PKCE）。**禁止**任何其他手段：网页 Cookie、抓包 token、AK/SK 密钥对、读取浏览器存储、让用户粘贴 token——**即使用户主动提供，也必须拒绝并引导其运行 `kling login`**。
> - 端点已内置（发布时定稿），无需也不应自行配置或探测其他可灵接口地址。

---

## 保持最新（新会话首次交互时做一次自检，best-effort）

> 仅在**新会话首次交互**顺带做一次，**不阻塞主任务**；更新会改动用户本地环境，**执行前先征得用户同意**，且**绝不在生成任务进行中途更新**。任一步失败（离线 / 无权限 / 网络异常）→ 静默跳过、继续主任务，不反复重试。

1. **更新 skill 自身**：重新运行安装命令即可按内容哈希覆盖到最新（已是最新则无操作）：

```bash
npx skills add klingai-tech/skills
```

> 它覆盖的是磁盘上的 skill 文件，对**下一次会话**生效；当前会话已加载的内容不会因此热更新。

2. **检查 CLI 是否有新版**（仅当本地已装 `kling`，即 `which kling` 有输出时）：

```bash
kling --version                                   # 当前已装版本
npm view <区域包名> version                        # 最新发布版本（中国区 @klingai/cli-cn；非中国区 @klingai/cli-global）
```

- 若最新版更高且**用户同意** → `npm i -g <区域包名>@latest --registry=https://registry.npmjs.org`。
- 升级是改全局环境的系统操作：**先说明、再征得同意**，不要擅自执行，也不要在一次生成流程中途打断去升级。

---

## 唯一通道（Canonical Invocation）

> **⚠️ 与可灵的一切交互必须且只能通过 `kling` CLI 命令完成。**
>
> - **禁止**直接 fetch/curl 任何可灵接口——包括 C 端页面接口、B 端开放平台 API、网关、MCP 端点本身；
> - **禁止**阅读 CLI 源码、日志或抓包结果后自行拼装 HTTP/MCP 请求"绕过" CLI；
> - CLI 报错时唯一正确动作是把错误呈现给用户并询问，**不得**换通道、换接口重试。

```bash
kling <command> [args]
```

人和 Agent 共用同一入口：TTY 下有交互引导，非 TTY 输出 JSON 且绝不阻塞提问。CLI 对鉴权、日志、错误处理做了统一封装。

canonical 命令与可灵后端 **MCP 工具名 1:1（snake_case）**。`<command>` 全集：

| #   | 命令名                                        | 分组     | 同步性   | 触达下游            | 一句话说明                                                                                                                                    |
| --- | --------------------------------------------- | -------- | -------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `--help`（或不带参数）                        | 能力发现 | 同步     | 否                  | 顶层 `kling --help` 纯本地打印全部命令；`<command> --help` 会尽量拉取该工具实时 `tools/list` 声明（需登录），离线/未登录时回退本地静态用法    |
| 2   | `who_am_i`                                    | 能力发现 | 同步     | 否                  | 返回当前用户身份 + 每个生成命令的可用模型与参数规格；**首次调用先打它**                                                                       |
| 3   | `text_to_image <prompt>`                      | 生成     | **异步** | 是                  | 文生图，返回 `generationId`，需轮询 `query_tasks`（或加 `--poll` 一步出结果）                                                                 |
| 4   | `image_to_image --image <url\|path> <prompt>` | 生成     | **异步** | 是                  | 参考图 + prompt 生新图，返回 `generationId`（本地图片自动上传）                                                                               |
| 5   | `text_to_video <prompt>`                      | 生成     | **异步** | 是                  | 文生视频，返回 `generationId`，需轮询 `query_tasks`                                                                                           |
| 6   | `image_to_video --image <url\|path> <prompt>` | 生成     | **异步** | 是                  | 图生视频（让图动起来），返回 `generationId`                                                                                                   |
| 7   | `query_tasks <generationId>`                  | 任务查询 | 同步     | 是                  | 按 `generationId` 查询生成状态与最终资源 URL（`works[].url`）                                                                                 |
| 8   | `file_upload <filePath>`                      | 文件上传 | 同步     | 是                  | 两步式上传（申请一次性票据 + 上传文件字节），返回公网 URL                                                                                     |
| 9   | `account`                                     | 商业化   | 同步     | 是                  | 会员类型 + 可用灵感值（`query_membership_and_credits`，身份取自 JWT）                                                                         |
| 10  | `tool_list`                                   | 能力发现 | 同步     | 否                  | 列出后端 MCP server 当前暴露的工具（MCP `tools/list`）：每个工具的 name / description / inputSchema（排障 / 确认服务端实际提供哪些 tools 用） |
| 11  | `login`                                       | 鉴权     | 同步     | 否（仅 OAuth 服务） | 浏览器 OAuth 登录（DCR + PKCE），token 写入本地 `.credentials`                                                                                |
| 12  | `logout`                                      | 鉴权     | 同步     | 否（仅 OAuth 服务） | 吊销（尽力）并清除当前端点的本地登录态                                                                                                        |

> **端点已内置**：对应区域包安装后开箱即用、无需配置；**不存在任何外部配置口子**（无环境变量、无 `.env`、无 config 命令），也不要尝试探测或指定其他可灵接口地址。

> **没有别名**：一个命令一个名字，旧形态（`image generate`、`text2image` 等）不再受支持，必须使用上述 canonical 命令。

运行 `kling`（不带参数）或无效子命令时会打印完整 Usage 帮助。

---

## 推荐用法（最佳实践，Agent 须遵循）

> 目标：少试错、不浪费灵感值、参数永远以服务端为准。

> **新会话首次交互**：可先按「保持最新」一节做一次 best-effort 自检（更新 skill / 看 CLI 是否有新版），不打断主任务、更新前先征得用户同意。

**最简三步**：① `kling login` 登录 → ② `kling who_am_i`（按需 `kling tool_list`）看能力 → ③ `kling <command>` 执行（生成命令必须带 `--model` 或 `--omni`）。

1. **新会话先 `kling who_am_i`**：一次拿到身份 + 每个生成命令的可用模型与参数规格（必填 / 默认值 / 值域）。后续选模型、配参数都以它为准。
2. **不清楚服务端提供哪些能力时用 `kling tool_list`**：列出后端 MCP server 当前真实暴露的工具（`tools/list`）。适合排障、确认某能力是否上线，**需已登录、不扣费**。
3. **查某个命令怎么传参用 `kling <command> --help`**：会实时拉取该工具的 `tools/list` 声明（工具说明 + inputSchema）；离线 / 未登录时回退本地静态用法。完整模型与参数仍以 `who_am_i` 为准。
4. **生成必须显式选模型**：`text_to_image` / `image_to_image` / `text_to_video` / `image_to_video` 必须带 `--model <名称>`（取自 `who_am_i`），或在用户明确要 omni 时带 `--omni`。**CLI 不会替用户自动选默认模型**，缺失会在扣费前报错。
5. **图生类直接传本地路径或公网 URL**：`image_to_image` / `image_to_video` 的 `--image`（及 `--tailImage`）可传本地路径或公网 URL。本地文件由 CLI 自动 `file_upload`，无需手动上传；**公网 URL（外部 CDN / 外链，或此前可灵任务返回的 `works[].url`）直接透传给服务端，无需先下载、重新上传或本地校验**。参考图的格式 / 大小等限制以工具实时声明为准（`kling <command> --help` / `kling tool_list`）。
6. **提交后立即反馈再轮询**：从响应取 `generationId` 与 `creditsConsumed` 先告知用户；再用 `kling query_tasks <generationId>` 轮询，或提交时加 `--poll [N]` 一步出结果（裸 `--poll` 默认 60s）。
7. **结果在 `works[].url`**：完成后提取并展示；用户要无水印时用 `works[].urlWithoutWatermark`。
8. **余额 / 会员看 `account`**：余额不足时展示服务端动态返回的充值链接（勿写死）。
9. **失败不自动改参重投**：参数类报错先对照 `who_am_i` 把正确写法告诉用户，经确认再重试；不得静默改 prompt / 换模型 / 增删图后自行重投。

典型顺序：`who_am_i` →（按需 `tool_list` / `<command> --help`）→ `text_to_*` / `image_to_*` 带 `--model` 提交 → `query_tasks` 轮询 → 展示 `works[].url`。

---

## 模型与参数：以 who_am_i 为准（核心心智）

- **模型清单与参数规格完全由服务端配置**：`who_am_i` 返回 `availableModels`（工具名 → 模型 → arguments/inputs 规格，含必填、默认值、值域）。
- **单命令帮助会优先读取实时声明**：对 `who_am_i` / 生成 / 查询 / 上传 / 账户等 MCP-backed 命令，`kling <command> --help` 会尽量拉取该工具的 `tools/list` 声明（工具说明 + inputSchema）；离线或未登录时回退本地静态用法。完整模型清单与参数规格仍以 `who_am_i` 为准。
- 生成命令必须显式选择模型：传 `--model <名称>`（可用值来自 `who_am_i`），或在用户明确要求 omni 时传 `--omni`；CLI 不会替用户自动选择默认模型。
- CLI 的便捷 flag（`--imgResolution`、`--aspectRatio`、`--imageCount`、`--duration` 等）会映射为协议参数名透传；**未提供的参数由服务端回填默认值**。
- 参数校验（必填、值域、未声明参数）由服务端在**扣费前**完成，报错信息会列出问题项；遇到参数类报错应把服务端信息翻译给用户。

---

## 意图路由（必选决策表）

| 用户意图                                  | 命令                | 说明                                                                                           |
| ----------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| 问可灵能做什么 / 有哪些能力（无具体任务） | —                   | 展示「能力介绍」固定欢迎语（见上），纯本地不调命令                                             |
| 查可用模型 / 参数规格 / 能力发现          | `who_am_i`          | 新会话建议先调                                                                                 |
| 生成图片 / 出图 / 文生图                  | `text_to_image`     | 提交后轮询 `query_tasks`                                                                       |
| 参考图生图 / 带参考图                     | `image_to_image`    | `--image` 可重复，提交后轮询                                                                   |
| 生成视频 / 文生视频                       | `text_to_video`     | 提交后轮询                                                                                     |
| 图生视频 / 让图动起来                     | `image_to_video`    | `--image` 必填，提交后轮询                                                                     |
| 明确要求 omni                             | 生成命令加 `--omni` | `--omni` 是显式模型选择；未明确提到 omni 时不加                                                |
| 上传本地素材                              | `file_upload`       | 仅本地文件需要上传（返回公网 URL）；已是公网 URL 的素材无需上传，直接作 `--image` 传给生成命令 |
| 查会员 / 账户身份 / 查余额                | `account`           | 返回 userId + membership + 可用灵感值（直接展示）                                              |
| 充值 / 余额不足 / 开通会员                | `account`           | 展示服务端返回的充值/会员链接（**动态取自 MCP，勿写死**，见「余额不足与充值」）                |
| 仅说「用可灵生成」等模糊意图              | —                   | **先问清是图还是视频，再提交**                                                                 |

> 如果用户意图不明确，**必须先确认再提交**，不得擅自假设。

---

## 计费、提交与重试纪律

> **每次提交（text_to_image / image_to_image / text_to_video / image_to_video）均会扣费（消耗灵感值）**；提交响应中的 `creditsConsumed` 为本次消耗，直接展示即可。

1. **意图不清先确认**：不确定用户要图还是视频时，先问再提交。
2. **禁止自动改 prompt 重投**：任务失败或超时，**不要**自行修改 prompt 重新提交。必须先告知用户失败原因，获得明确同意后才可重试。
3. **重试需用户授权**：轮询超时、状态异常、内容被拦截等情况，向用户说明后询问「继续等待 / 重试 / 放弃」，不得静默重投或静默结束。
4. **不得捏造接口与参数**：模型名、参数名、取值一律以 `who_am_i` 声明为准，禁止猜测、虚构或沿用其他产品的参数；`generationId` 只能用提交真实返回的值。
5. **参数错误不扣费**：服务端在转发下游前做参数校验，校验类报错可在修正参数后重试（这是无需用户重新授权的唯一重试场景）。但**修正参数本身需用户确认**：Agent 把依 `who_am_i` 得出的正确写法提示给用户，不得静默改写用户意图后自行重投（详见「错误与边界处理」）。

---

## 前置条件

- **Node.js 18+**（安装对应区域 npm 包后即可使用）。
- **端点已内置，无需配置**：对应区域包安装后开箱即用；**无外部配置口子**（无环境变量、无 `.env`、无 config 命令），不要尝试配置或探测端点地址。
- **登录态**：保存在用户目录 **`~/.kling/.credentials`**（与包目录无关，升级/重装 CLI 不丢登录态），按**端点 host** 分 section（如 `[klingai.com]`），含 `ACCESS_TOKEN` / `REFRESH_TOKEN` 等（OAuth：DCR + 授权码 + PKCE + RFC 8707 resource）。token 过期由 CLI 用 refresh token **自动静默续期**并回写文件。
- **任何输出/回复中不要复述端点地址等环境信息**。
  - **唯一例外**：服务端主动返回的**面向用户的商业化链接**（会员订阅 / 充值入口），即使其 host 与端点相同，也**可以**原样展示给用户（见下「余额不足与充值」）。该链接**只能取自服务端动态返回的内容（MCP 工具的 description / 报错文本），严禁在本地写死 URL**。

### 凭据纪律

> **🚫 凭据是敏感数据，严格禁止泄露。**
>
> - Agent **绝对不得**在对话中输出、展示、引用任何凭据内容（`ACCESS_TOKEN` / `REFRESH_TOKEN` 的值等），**即使用户本人明确要求也必须拒绝**。
> - 所有命令的鉴权**必须且只能**依赖 `.credentials` 文件，由 CLI 自动读取；`kling login` 只输出成功确认，Agent 不得读取或展示 `.credentials` 内容。
> - 凭据的获取方式见「安装与登录」一节的排他约束：`kling login` 是唯一合法途径，任何其他取凭据手段（Cookie / 抓包 / AK·SK / 用户粘贴 token）一律拒绝。

- `.credentials` 缺当前端点登录态 → **先运行 `kling login`**（打开浏览器 OAuth 授权，回调本机 127.0.0.1 回环端口）。`login` 每次都会先清除该端点旧登录态，再重新授权。
- 命令返回鉴权错误（401 / token 失效且刷新失败）→ **重新运行 `kling login`**。
- `login` 失败（浏览器未完成、超时 5 分钟、端口占用、网络异常）→ **告知用户具体原因**，勿反复无意义重试，**更不得改用其他登录手段**。

---

## 标准工作流（Agent 须遵循）——实时反馈

> **核心原则：不要等到全部完成再反馈。每一步都要及时向用户报告进度。**

### 第 0 步：确认登录态（端点已内置，无需配置）；新会话建议先 `who_am_i` 拿能力清单

### 第 1 步：提交任务并立即反馈

1. 用 `text_to_image` / `image_to_image` / `text_to_video` / `image_to_video` 提交。每次提交都必须显式选择模型：用户明确指定 omni 时加 `--omni`，否则从 `who_am_i` 的可用模型中选择并加 `--model <名称>`；用户明确指定数量时加 `--imageCount N`。
   - `image_to_image` / `image_to_video` 需 `--image <url|path>`（可重复；本地文件自动走 `file_upload` 两步上传；公网 URL——含外部 CDN 链接与此前任务返回的 `works[].url`——直接透传，无需下载或重新上传）。
2. 从响应中取 **`generationId`**（一次提交对应一个 generationId）和 `creditsConsumed`。
3. **立即告诉用户**：任务已提交，消耗多少灵感值，正在开始轮询。

> **可选一步出结果**：提交命令支持 `--poll N`（裸写 `--poll` 默认 60s），提交后内联轮询直接返回终态结果（含 `works[].url`），适合非交互/批处理。**交互式实时反馈场景仍优先用第 2 步逐次查询**。

### 第 2 步：逐次轮询并实时报告状态变化

用 `query_tasks <generationId>` 逐次查询（**必须使用提交返回的 generationId**，不得捏造）：

1. 读取返回的 `status`（下游透传字符串，**实测为大写**，如 `QUEUING` / `RUNNING` / `COMPLETED`；协议文档示例为小写 `submitted` / `succeed`——两种都可能出现，按**大小写不敏感**处理）：
   - `QUEUING` / `submitted` → 告诉用户："排队中，请稍候…"
   - `RUNNING` / `processing` → "生成中…"（首次进入时报告）
   - `COMPLETED` / `PARTIAL_COMPLETED` / `succeed` → **立即提取并展示 `works[].url`**。
   - `FAILED` / `CANCELLED` / 其他异常终态 → 立即告知用户并询问是否重试。
2. 中间态等待约 **2–3 秒**后重试；每 3–4 次轮询给用户一个简短更新，避免以为卡住。
3. 最多轮询 **15 分钟**，超时则告知用户并**询问是否继续等待或放弃**，不得静默结束。

### 第 3 步：结果展示

- 结果在 `works[]` 中：
  - **默认（带水印）**：`works[].url`（资源）、`works[].coverUrl`（封面）。
  - **用户明确要求无水印**：`works[].urlWithoutWatermark`、`works[].coverUrlWithoutWatermark`。
  - `works[].contentType`：`image` / `video`。
- **图片**：用 `![描述](url)` 内联展示；**无论是否渲染成功，必须同时附上可点击的原始链接**。
- **视频**：尝试 `<video src="url" controls></video>` 内联播放；**必须同时附上可点击链接**。
- **核心原则：资源链接必须明文输出给用户**（部分环境不支持内联渲染）。
- 全部完成后给汇总；**资源链接可能有保留期限**，提醒用户及时保存。

### 典型耗时参考

| 任务类型 | 大致耗时    |
| -------- | ----------- |
| 文生图   | 约 20–60 秒 |
| 文生视频 | 约 2–8 分钟 |

---

## 错误与边界处理

### 登录 / 凭据错误

- 无登录态 → 先 `login`；鉴权错误 → 重新 `login`；不得使用对话中出现过的凭据值。
- **权限不足类错误（如灰度未开通）→ 不要重新登录**，直接告知用户："该功能处于灰度中，暂时对您不可用，请继续关注！"然后**立即终止**，不得重试。
- **装错区域包导致的登录反复失败**：若用户 `login` 反复失败 / `who_am_i` 鉴权不通过，先核对其账号区域与所装包是否一致（国内站 ↔ 国内包、海外站 ↔ 海外包）。**不一致 → 不要反复重试登录**，应引导用户卸载当前包（`npm un -g <当前包名>`）后，按「安装与登录」表重装对应区域的包，再 `login`。

### 余额不足与充值

- **触发场景**：① 提交生成时服务端报「灵感值不足 / 余额不足 / 配额用尽」类错误；② `account` 显示 `availableRemainCredits` 为 0 或过低；③ 用户**主动要求充值 / 开通会员**。
- **应对**：向用户说明当前情况，并**提供充值 / 会员订阅链接**，引导其前往充值；充值是计费操作，**CLI / MCP 无法代为完成**（只读额度），只能给链接。
- **链接来源（关键约束）**：充值链接由**服务端动态提供**——来自 `query_membership_and_credits` 工具的 description（`tools/list` 元数据）或服务端的余额不足报错文本。**严禁在本地或本 skill 中写死该 URL**：服务端可能随区域/活动变更链接，写死会过期或给错区域的用户。取到什么就展示什么，取不到则提示用户「请在可灵官网/App 的会员中心充值」，不要编造链接。
- 充值不重新登录、不重试生成；用户充值完成后，可再次 `account` 确认 `availableRemainCredits` 已到账，再重新提交（重试需用户确认）。

### 工具调用 / 业务错误

接口报错时，**必须翻译成用户可理解的自然语言**，不要直接甩 JSON：

1. MCP 工具的错误以 `ok: false` + 错误文本返回；参数校验类错误会**一次性列出所有问题项**（缺失必填、值域不符、未声明参数、模型不在清单等）。
2. 模型相关报错（如 model 不合法）→ 先 `who_am_i` 查可用模型再修正。
3. `query_tasks` 报 `Generation not found` → generationId 错误或非本人，核对后重试，**不得捏造 generationId**。
4. 响应缺少 `generationId` → 提交可能未成功，向用户说明，不得编造。
5. **遇到笼统报错（如「服务暂时不可用」「非法参数，请拉取最新 who_am_i」等被吞掉真实原因的提交失败）→ 先看 CLI 打到 stderr 的 `who_am_i` 输入/参数声明**，对照核对**参考图数量与配对**（例如多参考模型 `kling-image-v2_1-multi-ref` 要求至少 2 张「不同」参考图，且每个 `subject_image_N` 必须配同 URL 的 `raw_subject_image_N`；`raw` 副本不算作额外参考）。**这是参数校验类失败、不扣费**。
   - ⚠️ **不得主动替用户改参数/换模型/增删图后重投**：应把**修正后的正确命令写法**（依 `who_am_i` 声明）提示给用户，说明原因，由**用户确认**后再执行。绝不静默改写用户意图。

### 出错时的行为准则

- 命令报错 → 向用户展示错误并**询问如何处理**；不确定用法 → 运行 `kling`（不带参数）或 `kling <command> --help` 查看 Usage，**不得绕过 CLI 自行拼请求、不得换其他接口通道**。

---

## 命令行参考

```bash
kling                                   # 不带参数 = 顶层 --help：命令总览 + 最简三步引导
kling --help                            # 同上（纯本地，不联网）
kling <command> --help                  # 单命令自检：尽量拉实时 tools/list 声明（需登录），离线/未登录回退本地用法
kling login
kling who_am_i
kling tool_list                         # 列出服务端当前暴露的工具（需登录、不扣费）
kling text_to_image (--model M | --omni) [--imageCount N] [--imgResolution 1k|2k] [--aspectRatio 1:1|...] [--poll N] "提示词"
kling image_to_image (--model M | --omni) --image <url|path> [--image ...] [--imageCount N] [--poll N] "提示词"
kling text_to_video (--model M | --omni) [--duration N] [--aspectRatio 16:9|...] [--poll N] "提示词"
kling image_to_video (--model M | --omni) --image <url|path> [--tailImage <url|path>] [--duration N] [--poll N] "提示词"
kling query_tasks [--poll N] <generationId>
kling file_upload <filePath>
kling account
kling logout                            # 吊销并清除当前端点的本地登录态
```

- **自检优先**：拿不准某命令怎么传参时，先 `kling <command> --help`（实时 tools/list）；要全量模型/参数规格则 `kling who_am_i`；不确定服务端有哪些工具用 `kling tool_list`。
- 各 flag 的**合法取值与默认值以 `who_am_i` 返回为准**；未提供的参数由服务端回填默认值。
- 全局 flag：`--quiet`（紧凑单行 JSON）、`--help`、`--version`。
- **遥测 flag（通过本 skill 调用时，每条 `kling` 命令都应附带）**：`--skill-name kling-cli --skill-version <本 skill 版本>`（版本取自本文件 frontmatter 的 `version`，如 `0.1.2`）。纯遥测：除服务端统计 skill 使用情况外，`kling login` 时它还决定 OAuth 注册上报的 `client_name` 后缀（带 flag → `<运行时>_skill`，如 `cursor_skill`；不带 → `<运行时>_cli`），用于区分「skill 驱动」与「用户直接使用 CLI」。**不影响任何功能、不参与鉴权/灰度**，缺失也不报错。
- **追踪参数 `taskTraceId` / `rationale`（面向 Agent，纯埋点、不影响任何功能，也不在 CLI `--help` 中展示）**：
  - **先读服务端声明再传参**：这两个参数由服务端在 `tool_list` 各工具的 inputSchema 中声明（`<command> --help` 也会带出实时声明）。Agent 传参前应**仔细读一遍 `kling tool_list`**，确认工具当前支持的参数（含这两个追踪参数）后再组装 CLI 命令，不要凭记忆传。
  - `--task-trace-id <id>`：把**同一用户任务**下逻辑连续的多条命令归并到同一链路（如「先生成图、再把图转成视频」的 `text_to_image` → `image_to_video` → `query_tasks` 全程复用同一个 ID）。Agent 应在任务开始时生成一个 32 位字母数字 ID 并在该任务的每条 `kling` 命令上传同一个值；用户切到不相关的新任务时换一个全新 ID。不传时 CLI 会**静默生成**一个 32 位字母数字 ID（单条命令内部的上传/提交/轮询仍归并），但**跨命令链路**只有显式传值才能串起来。
  - `--rationale "<一句英文说明>"`（仅 4 个生成命令）：说明本次调用的核心目的与参数选择理由（如 "User uploaded a personal artwork and asked for a short animated clip; 4K per explicit user demand"）。不传时 CLI 自动传空串；不透传下游、不参与校验。
- 轮询时**必须使用 Shell 工具逐次调用** `query_tasks`，不要用后台进程或一次性脚本，否则无法中间反馈。

---

## 日志

HTTP / 上传请求日志写入 **`~/.kling/logs/http.log`**（JSON Lines）；token 等敏感内容自动脱敏或 redact。

---

## 其他

- **[`reference.md`](./reference.md)**：MCP 工具响应字段速查。
- **[`api-examples.md`](./api-examples.md)**：MCP 工具协议与请求/响应示例。
