# 发布指南

## 发布前检查

### 1. 确认发布内容（不含涉密文件）

```bash
npm pack --dry-run
```

预期包含的文件：
- `README.md`
- `package.json`
- `src/cli.js`
- `src/config.js`
- `src/index.js`
- `src/logger.js`
- `src/proxy.js`
- `src/ui.html`

**确认不包含**：`config.json`、`logs/`、`.claude/`、`test/`

### 2. 更新版本号

```bash
# 补丁版本（bug fix）
npm version patch

# 次版本（新功能）
npm version minor

# 主版本（破坏性变更）
npm version major
```

### 3. 登录 npm

```bash
npm login
# 按提示输入用户名、密码、邮箱（或 OTP）
```

---

## 发布

```bash
npm publish
```

---

## 安装与使用（发布后）

### 全局安装

```bash
npm install -g llm-responses-proxy
```

### 初始化配置

首次运行时会自动在当前目录创建 `config.json`：

```bash
llm_resp_proxy start
```

生成的 `config.json` 示例：

```json
{
  "port": 18188,
  "uiPort": 18189,
  "activeProvider": "default",
  "providers": [
    {
      "name": "default",
      "baseUrl": "https://api.openai.com",
      "apiKey": ""
    }
  ]
}
```

编辑 `config.json`，填入你的 `baseUrl` 和 `apiKey`，然后重新执行 `llm_resp_proxy start`。

也可以通过环境变量覆盖 API Key（避免明文写入配置文件）：

```bash
PROVIDER_DEFAULT_API_KEY=sk-xxx llm_resp_proxy start
```

### 命令

| 命令 | 说明 |
|------|------|
| `llm_resp_proxy start` | 启动代理服务器（默认端口 18188） |
| `llm_resp_proxy ui` | 在浏览器中打开配置 UI（默认端口 18189） |

### 自定义配置路径

```bash
CONFIG_PATH=/path/to/my-config.json llm_resp_proxy start
```

---

## 本地测试安装

发布前可以在本地验证安装效果：

```bash
npm pack
npm install -g llm-responses-proxy-*.tgz
llm_resp_proxy start
```

测试完后卸载：

```bash
npm uninstall -g llm-responses-proxy
rm llm-responses-proxy-*.tgz
```
