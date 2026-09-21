# 无限重试策略（429 / 5xx / 超时等）

Harness 对模型 API 的重试是 **dsh 核心内置**的（`@deepseek-ai/dsh-llm` 的
`retryPolicy`），不是本插件的功能。默认是 `mode: normal`：对
`RATE_LIMIT(429)`、`SERVER(5xx)`、`TIMEOUT`、`TRANSPORT`、空响应重试 **5 次**
（指数退避 500ms → 10s，±10% 抖动）。

本仓库附带 `scripts/apply-retry-policy.sh`：一行命令把所有 provider 改成
**`mode: always`（无限重试）**。

## 用法（一行）

```bash
bash <(curl -sL https://raw.githubusercontent.com/<你的用户名>/dsh-tool-browser/main/scripts/apply-retry-policy.sh)
```

做了什么：
- 备份 `~/.dsh/settings.yaml` → `settings.yaml.bak-<时间戳>`
- 在每个 `llm-pi-ai.providers.<id>` 下写入：

```yaml
      retryPolicy:
        mode: always
```

- 幂等：已配置的跳过；无 `llm-pi-ai` / 无 `providers` 时报错退出
- 改完重启 dsh（或 `dsh-web` 服务）生效

## 效果与边界

| 错误 | mode: always 行为 |
|---|---|
| 429 RATE_LIMIT | 无限重试（尊重 `retry-after`，指数退避） |
| 5xx SERVER / TIMEOUT / TRANSPORT | 无限重试 |
| 空响应 | 无限重试 |
| 401 / 403（key 无效/无权限） | 也会重试——但换 key 才治本；想排除认证错误请改回 `mode: normal` + `maxRetries` |

## 手动配置（不用脚本）

编辑 `~/.dsh/settings.yaml`，在 provider 下加：

```yaml
llm-pi-ai:
  providers:
    <providerId>:
      retryPolicy:
        mode: always        # 无限重试
        # 或
        # mode: normal
        # maxRetries: 20    # 有限次数
        # retryableCodes: [RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
```

重启后生效。
