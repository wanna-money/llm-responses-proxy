# llm-responses-proxy

将 [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses) 请求转换为 [Chat Completions API](https://platform.openai.com/docs/api-reference/chat) 格式的本地代理，转发至上游提供商后再将响应转换回来。

---

## 为什么需要它

Responses API 是 OpenAI 为新型 Agent 项目推荐的格式，但大多数 LLM 提供商（Azure OpenAI、Ollama、vLLM 及其他兼容 OpenAI 的服务）目前只暴露 Chat Completions 接口。本代理让使用 Responses API 的客户端——包括 Claude Code、基于 `openai.responses.*` 构建的工具，以及任何采用新 Responses 格式的 SDK——无需改动代码即可对接任意 Chat Completions 提供商。

---

## 架构

```
客户端 (Responses API) → 代理 :18188 /v1/responses → 转换 → 上游 /v1/chat/completions
                                                                        ↓
客户端 ← 转换 ← 代理 ←──────────────────────────────────── 上游响应

配置 Web UI → :18189/ui
```

代理进程（`:18188`）与 Web UI（`:18189`）由 CLI 作为兄弟进程管理。Web UI 负责代理的生命周期（启动/停止/重启），并实时展示分页请求日志。

---

## 安装

### 全局安装（推荐）

```bash
npm install -g llm-responses-proxy
llm-responses-proxy start
```

### npx（免安装）

```bash
npx llm-responses-proxy start
```

### 从源码运行

```bash
git clone https://github.com/wanna-money/llm-responses-proxy.git
cd llm-responses-proxy
npm install
npm start
```

---

## 快速开始

1. **启动代理**

   ```bash
   llm-responses-proxy start
   ```

   首次运行会在当前目录自动创建默认 `config.json`。

2. **配置提供商**

   在浏览器中打开 `http://localhost:18189/ui`，或直接编辑 `config.json`。

3. **将客户端指向代理**

   ```bash
   export OPENAI_BASE_URL=http://localhost:18188
   ```

   所有 Responses API 请求都会被自动转换并转发。

---

## 配置

### config.json

```json
{
  "port": 18188,
  "uiPort": 18189,
  "activeProvider": "openai",
  "providers": [
    {
      "name": "openai",
      "baseUrl": "https://api.openai.com",
      "apiKey": "sk-..."
    },
    {
      "name": "azure-openai",
      "baseUrl": "https://YOUR_RESOURCE.openai.azure.com",
      "apiKey": "your-azure-key",
      "apiKeyHeader": "api-key"
    },
    {
      "name": "ollama",
      "baseUrl": "http://localhost:11434"
    },
    {
      "name": "anthropic-passthrough",
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "sk-ant-...",
      "responsesPassthrough": true
    }
  ]
}
```

**提供商字段说明：**

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✓ | 唯一提供商名称（用于环境变量映射） |
| `baseUrl` | ✓ | 上游基础 URL，末尾的 `/v1` 会自动去除 |
| `apiKey` | | API 密钥。若不填，直接透传客户端的 `Authorization` 请求头 |
| `apiKeyHeader` | | API 密钥使用的请求头名称（默认为 `Authorization: Bearer <key>`）。Azure OpenAI 请填 `"api-key"` |
| `responsesPassthrough` | | 设为 `true` 可跳过转换，将 Responses API 请求直接透传（适用于原生支持 Responses API 的提供商） |

### 环境变量

无需修改 `config.json` 即可覆盖任意配置项：

| 变量 | 说明 |
|------|------|
| `PROVIDER_<NAME>_API_KEY` | 指定提供商的 API 密钥（名称大写，非字母数字字符替换为 `_`） |
| `PROVIDER_<NAME>_BASE_URL` | 指定提供商的基础 URL |
| `PORT` | 代理监听端口（默认 `18188`） |
| `UI_PORT` | Web UI 端口（默认 `18189`） |
| `LOG_PATH` | 日志文件路径（默认为当前目录下的 `logs/proxy.log`） |
| `CONFIG_PATH` | 配置文件路径（默认为当前目录下的 `config.json`） |

**示例：**

```bash
# 覆盖 "openai" 提供商的 API 密钥和 Base URL
PROVIDER_OPENAI_API_KEY=sk-... PROVIDER_OPENAI_BASE_URL=https://your-gateway llm-responses-proxy start

# 不配置 API 密钥，直接透传客户端凭证
PROVIDER_OPENAI_BASE_URL=http://localhost:11434 llm-responses-proxy start
```

含特殊字符的提供商名称映射到环境变量时，会先大写再将非字母数字字符替换为 `_`。例如提供商 `"azure-openai"` 对应 `PROVIDER_AZURE_OPENAI_API_KEY`。

---

## CLI 命令

```
llm-responses-proxy start   启动代理 + Web UI（访问 http://localhost:18189/ui）
llm-responses-proxy ui      在默认浏览器中打开 Web UI
```

---

## API 参考

### 代理（`:18188`）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/v1/responses` | Responses API——转换为 Chat Completions 后转发（若配置了 `responsesPassthrough: true` 则直接透传） |
| `POST` | `/v1/chat/completions` | Chat Completions——清洗后直接转发 |
| `GET` | `/v1/models` | 直接转发至上游 |
| `GET` | `/health` | 当前活跃提供商信息 |

### Web UI（`:18189`）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/ui` | 配置与日志管理面板 |
| `GET` | `/api/config` | 获取当前配置（API 密钥已脱敏） |
| `PUT` | `/api/config` | 更新并持久化配置 |
| `POST` | `/api/restart` | 重启代理进程 |
| `POST` | `/api/stop` | 停止代理进程 |
| `GET` | `/api/status` | 代理进程状态 |
| `GET` | `/api/logs` | 请求日志（支持 `?limit=100&offset=0`，每页最多 500 条） |
| `DELETE` | `/api/logs` | 清空所有日志 |

---

## 转换参考

### 请求（Responses → Chat Completions）

| Responses API 字段 | Chat Completions 字段 | 说明 |
|--------------------|-----------------------|------|
| `input`（字符串） | `messages` | 包装为 `[{ role: "user", content }]` |
| `input`（数组） | `messages` | 按类型逐项转换（见下文） |
| `instructions` | 前置 `system` 消息 | |
| `max_output_tokens` | `max_tokens` | |
| `text.format` | `response_format` | `json_schema` 结构正确嵌套 |
| `developer` 角色 | `system` 角色 | |
| `function_call` 条目 | `assistant` 消息的 `tool_calls` | 与相邻调用合并 |
| `function_call_output` 条目 | `tool` 角色消息 | 延迟到其 `assistant` 消息之后输出，即使在数组中顺序颠倒也能正确处理 |
| `input_image` 内容类型 | `image_url` 内容类型 | 保留 `detail` 字段 |
| `tools[].{name,description,parameters}` | `tools[].function.{…}` | 内置工具类型（web_search、file_search 等）会跳过并记录警告日志 |
| `tool_choice: { type:"function", name }` | `tool_choice: { type:"function", function: { name } }` | 若指定函数名不在工具列表中，回退为 `"auto"` |
| `parallel_tool_calls` | `parallel_tool_calls` | 仅在有工具时转发 |

Responses API 专属字段（`store`、`reasoning`、`metadata`、`modalities`、`audio` 等）在转发前会被剥除。

**多轮工具调用**：`function_call_output` 条目会与输入数组中任意轮次的 `function_call` 条目进行匹配，包括作为 `assistant` 消息携带的上一轮 `tool_calls`。若输出条目在数组中出现在对应调用之前，会先缓冲，待 `assistant` 消息输出后再按正确顺序追加。

### 响应（Chat Completions → Responses）

| Chat Completions 字段 | Responses API 字段 |
|----------------------|--------------------|
| `choices[0].message.content` | `output[].content[].text`（`output_text` 类型） |
| `choices[0].message.refusal` | `output[].content[]`（`refusal` 类型） |
| `choices[0].message.tool_calls[]` | `output[]` `function_call` 条目 |
| `finish_reason: "length"` | `status: "incomplete"`，`incomplete_details.reason: "max_output_tokens"` |
| `finish_reason: "content_filter"` | `status: "incomplete"`，`incomplete_details.reason: "content_filter"` |
| `usage.prompt_tokens` | `usage.input_tokens` |
| `usage.completion_tokens` | `usage.output_tokens` |

### 流式事件映射

| 触发条件 | 输出的 Responses API 事件 |
|----------|--------------------------|
| 首个数据块 | `response.created`、`response.in_progress` |
| 首个文本 delta | `response.output_item.added`、`response.content_part.added` |
| 每个 `delta.content` | `response.output_text.delta` |
| 首个 `delta.tool_calls` | `response.output_item.added`（function_call） |
| 每个 `delta.tool_calls[].function.arguments` | `response.function_call_arguments.delta` |
| 出现 `finish_reason` | `response.content_part.done`、`response.output_item.done`、`response.function_call_arguments.done`、`response.completed` / `response.incomplete` |
| 流意外结束（无 `[DONE]` 且无 finish_reason） | `response.failed` |

---

## 日志

请求日志保存至 `logs/proxy.log`（或 `$LOG_PATH`），最多保留 1 000 条。Authorization 请求头及请求/响应体中的 API 密钥会自动脱敏。可通过 Web UI 分页查看和清空日志。

---

## 开发

```bash
git clone https://github.com/wanna-money/llm-responses-proxy.git
cd llm-responses-proxy
npm install

# 运行测试
npm test

# 启动（代理 :18188，UI :18189）
npm start
```

### 测试

测试使用 Node.js 内置 `node:test`，无需额外依赖。

```bash
npm test
```

| 文件 | 覆盖范围 |
|------|----------|
| `test/config.test.js` | 配置加载、环境变量覆盖、`saveConfig` 校验 |
| `test/proxy.test.js` | 请求/响应转换、工具调用顺序、多轮对话 |
| `test/streaming.test.js` | SSE 流解析与 Responses API 事件映射 |

---

## 发布

```bash
# 1. 确保所有测试通过
npm test

# 2. 升级版本号（更新 package.json 并创建 git tag）
npm version patch   # 或: minor | major

# 3. 发布到 npm（prepublishOnly 钩子会再次执行 npm test）
npm publish

# 4. 推送提交和 tag 到 GitHub
git push origin master --tags
```

`package.json` 中的 `files` 字段限制发布内容仅包含 `src/`、`README.md` 和 `LICENSE`，`config.json`（可能含 API 密钥）不会被发布。

> **注意：** 执行 `npm publish` 前，需先通过 `npm login` 登录，并确认对 `llm-responses-proxy` 包有发布权限。

---

## 环境要求

- Node.js ≥ 18.0.0

---

## 许可证

MIT
