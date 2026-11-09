# dsh-ninja-net-heal

DeepSeek Harness（DSH）插件：**外网访问失败时自动修复**。

规则很简单——当访问外网站点（如 `github.com`）失败时，先启动 `NinjaDesktop`、开启它的**系统代理**与 **TUN**，然后重试原地址；只有在修复仍然失败时，才去尝试别的办法。

插件把这个规则做成了三件事：

| 组成 | 作用 |
| --- | --- |
| `net_self_heal` 工具 | 模型可主动调用：探测 URL → 拉起程序 → 开代理/TUN → 重试，并返回每一步的真实结果 |
| 系统提示词片段 | 告诉模型「网页失败时先调 `net_self_heal`，不要直接放弃」 |
| 失败自动修复 | 监听 `tools/result`，`web_fetch` / `web_search` 等工具报错时在后台静默修复（带冷却，避免反复重启） |

## 工作原理

NinjaDesktop 内置 **mihomo** 内核，因此不需要模拟鼠标去点界面：

- **TUN** —— 通过内核外部控制器 `PATCH /configs {"tun":{"enable":true}}` 开启（默认 `127.0.0.1:9799`，密钥读自 `kernel_session.json`）。
- **系统代理** —— 写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `ProxyEnable` / `ProxyServer`，再调用 WinINet `InternetSetOption` 让设置立即生效；同时把 `appconfig.yaml` 里的 `system_proxy` / `tun_mode` 置为 `true`，保证程序下次启动仍保持开启。
- **进程** —— 内核不可达时先看 `NinjaDesktop.exe` 是否在跑；没跑才用 `exePath` 启动并等待控制器就绪。

探测同时走两条路：**直连**（Node 原生，不经过系统代理）和**经本地代理**（`CONNECT` 隧道 + TLS）。两者都失败才判定为「外网不通」，避免误修复。

## 安装

在 DSH 中把本目录作为本地 bundle 安装：

```powershell
# 在任意会话中让 DSH 执行：
#   plugin_manager action=install_bundle target=<本目录绝对路径>
```

或手动：

```powershell
cd C:\Users\<you>\dsh_work1\dsh-ninja-net-heal
# 然后调用 plugin_manager install_bundle，target 为上行的绝对路径
```

安装后插件行出现在 **设置 → 插件** 中，工具 `net_self_heal` 立即可用。

## 配置

在 profile 的 `cordis.patch.yml` 中修改本插件行的 `config`（未声明的字段使用内置默认值）：

```yaml
- insert:
    - id: dsh-ninja-net-heal
      name: dsh-ninja-net-heal
      config:
        exePath: C:\Program Files\NinjaDesktop\NinjaDesktop.exe
        dataDir: C:\Users\<you>\AppData\Local\NinjaDesktop
        controllerPort: 9799
        proxyPort: 7897
        probeUrl: https://github.com
        probeTimeoutMs: 8000
        launchTimeoutMs: 45000
        autoHeal: true
        healCooldownMs: 60000
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `exePath` | `C:\Program Files\NinjaDesktop\NinjaDesktop.exe` | 程序路径，内核未运行时用于启动 |
| `dataDir` | `%LOCALAPPDATA%\NinjaDesktop` | 存放 `kernel_session.json` / `appconfig.yaml` 的目录 |
| `controllerPort` | `9799` | mihomo 外部控制器端口 |
| `proxyPort` | `7897` | 混合代理端口（写入系统代理、用于代理探测） |
| `probeUrl` | `https://github.com` | 未指定 URL 时的探测目标 |
| `probeTimeoutMs` | `8000` | 单次探测超时 |
| `launchTimeoutMs` | `45000` | 启动后等待控制器就绪的上限 |
| `autoHeal` | `true` | web 工具失败后是否自动修复 |
| `healCooldownMs` | `60000` | 两次自动修复的最小间隔 |

## 工具返回值

```jsonc
{
  "healed": true,            // 最终是否恢复访问
  "needed": true,            // 是否触发了修复
  "target": "https://github.com",
  "controller": { "port": 9799, "reachable": true },
  "probes": { "direct": { "ok": true, "status": 200 }, "proxy": { "ok": true, "status": 200 } },
  "steps": [
    { "step": "probe",        "ok": false, "detail": "直连 ECONNRESET；代理 ECONNRESET" },
    { "step": "app",          "ok": true,  "detail": "NinjaDesktop 内核已在运行" },
    { "step": "tun",          "ok": true,  "detail": "TUN 已开启" },
    { "step": "system-proxy", "ok": true,  "detail": "系统代理已开启" },
    { "step": "persist",      "ok": true,  "detail": "appconfig.yaml 已记录 system_proxy/tun_mode = true" },
    { "step": "retry",        "ok": true,  "detail": "重试：直连 OK；代理 OK" }
  ],
  "elapsedMs": 3176,
  "summary": "已修复外网访问：https://github.com"
}
```

`healed: false` 时 `steps` 会指出到底哪一步失败，不会谎报成功。

## 测试

两个脚本都不依赖 DSH，直接用 Node 跑：

```powershell
node test/smoke.mjs          # 健康目标不修复 / 故障目标走完整修复链路
node test/repair-paths.mjs   # 先关掉 TUN 与系统代理，验证 ensure* 真的能拨回开启
```

`repair-paths.mjs` 会在结束时让 TUN 与系统代理保持开启。

## 限制

- 仅 Windows：依赖注册表、WinINet、`tasklist`、PowerShell 5.1。
- 只处理「程序已在/可启动 + 内核可控」的情况；节点全部失效、订阅过期、内核崩溃需要用户自己在 NinjaDesktop 里处理。
- 若 NinjaDesktop 的内核控制器关闭或改了端口，需同步修改 `controllerPort`。
- 自动修复是**静默**的：它恢复连通性，但不会替模型重发请求，重试仍由模型完成。

## 许可证

MIT
