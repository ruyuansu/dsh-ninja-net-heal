# dsh-ninja-net-heal

DeepSeek Harness（DSH）插件：**访问网页时自动开代理/TUN，访问结束自动关掉**。

规则：需要访问外部网站时，自动开启 `NinjaDesktop` 的**系统代理**与 **TUN**；访问结束后恢复到访问前的状态，避免代理长期常驻。如果网页仍然失败，`net_self_heal` 会做一次修复并把每一步的真实结果报出来。

## 行为

| 时机 | 动作 |
| --- | --- |
| web 工具执行前（`web_fetch` / `web_search` / `read_page`） | 开启系统代理 + TUN，然后才真正发起请求 |
| 最后一次 web 调用结束 + 空闲 `idleGraceMs` | 按 `releaseMode` 处理：默认恢复到访问前状态 |
| 回合结束（`turn/end`） | 立即关闭，并清理可能残留的租约 |
| web 调用失败 | 后台 `net_self_heal` 再修一次 |

连续多个 web 调用不会反复开关：用**租约计数**合并，只有全部结束后才处理。默认 `releaseMode: restore`——**恢复到访问前的状态**：原来关着就在结束后关掉，原来你自己开着就保持开启、不干扰。想强制每轮结束后都关闭，改成 `releaseMode: disable`。

## 关键修复：系统代理「打不开」

v1 直接写注册表 `ProxyEnable`、直接改内核 `tun`，但 **NinjaDesktop 自己持有这两个开关的状态并会回写**，所以看起来「刚打开又自己关了」。

v2 改走程序自己的接口，这些才是权威入口：

| 接口 | 作用 |
| --- | --- |
| `POST /api/sysproxy/enable` / `disable` | 真正开关系统代理（由服务提权写 WinINet，立即生效） |
| `GET /api/sysproxy/status` | 读真实状态 |
| `PUT /api/config` `{system_proxy, tun_mode}` | 开 / 关 TUN（会同步内核与 `appconfig.yaml`） |
| `GET 127.0.0.1:9799/configs` | 校验内核 TUN 是否真的开了 |

每次切换后都会**轮询校验三处状态**（应用、注册表、内核）；若应用接口报成功但注册表仍是关的，自动降级为直接写注册表 + `InternetSetOption` 刷新，再校验一次。写入 `/api/config` 采用「读出完整配置 → 合并两个字段 → 写回」，不会覆盖你的其他设置。

## 安装

```powershell
# 让 DSH 执行：plugin_manager action=install_bundle target=<本目录绝对路径>
```

安装后：**设置 → 插件** 中出现该插件；工具 `net_self_heal` 可用。

> 注意：`install_bundle` 是链接安装，profile 指向本目录，**移动或删除目录会导致插件失效**。

## 配置

```yaml
- insert:
    - id: dsh-ninja-net-heal
      name: dsh-ninja-net-heal
      config:
        exePath: C:\Program Files\NinjaDesktop\NinjaDesktop.exe
        appBaseUrl: http://127.0.0.1:9190
        controllerPort: 9799
        proxyPort: 7897
        manageOnWebAccess: true
        idleGraceMs: 15000
        releaseMode: restore
        probeUrl: https://github.com
        autoHeal: true
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `exePath` | `C:\Program Files\NinjaDesktop\NinjaDesktop.exe` | 后端不可达时用于启动程序 |
| `appBaseUrl` | `http://127.0.0.1:9190` | 程序后端地址（系统代理接口所在） |
| `controllerPort` | `9799` | mihomo 控制器，用于校验 TUN |
| `proxyPort` | `7897` | 混合代理端口 |
| `manageOnWebAccess` | `true` | 总开关：是否在网页访问前后自动开关 |
| `idleGraceMs` | `15000` | 最后一次 web 调用后多久关闭 |
| `releaseMode` | `restore` | `restore` 恢复到访问前状态；`disable` 每轮结束无条件关闭 |
| `probeUrl` | `https://github.com` | 默认探测目标 |
| `autoHeal` | `true` | web 调用失败后是否后台修复 |
| `launchTimeoutMs` | `45000` | 启动后等待后端就绪 |
| `verifyAttempts` / `verifyDelayMs` | `8` / `500` | 切换后的校验轮询 |

## 工具

`net_self_heal({ url })` 返回：

```jsonc
{
  "healed": false,
  "needed": true,
  "target": "https://dsh-net-heal-probe.invalid",
  "switched": true,
  "probes": { "direct": { "ok": false, "error": "ECONNRESET" }, "proxy": { "ok": false, "error": "ECONNRESET" } },
  "steps": [
    { "step": "probe",    "ok": false, "detail": "直连 ENOTFOUND；代理 ECONNRESET" },
    { "step": "config",   "ok": true,  "detail": "tun_mode/system_proxy = true" },
    { "step": "sysproxy", "ok": true,  "detail": "已请求开启系统代理" },
    { "step": "verify-on","ok": true,  "detail": "proxy=true tun=true" },
    { "step": "retry",    "ok": false, "detail": "重试：直连 ECONNRESET；代理 ECONNRESET" }
  ],
  "elapsedMs": 4210,
  "summary": "修复未能恢复访问：…"
}
```

`healed: false` 时 `steps` 明确指出哪一步失败，不会谎报成功。

## 测试

```powershell
node test/lifecycle.mjs
```

覆盖：干净状态 → 开启（三处都真开）→ 5 秒稳定性 → 关闭（三处都真关）→ 可达目标不误修 → 不可达目标走完整修复链路 → 回到关闭。结束时保持关闭。

## 限制

- 仅 Windows：依赖程序后端、注册表、WinINet、`tasklist`、PowerShell 5.1。
- 程序必须能提供 `9190` 后端；内核被手动停掉时需要先启动程序。
- 频繁开关 TUN 有约 1–3 秒建立时间，所以用 `idleGraceMs` 合并连续访问；把该值调大可以减少抖动，代价是代理多留一会儿。
- `releaseMode: restore`（默认）只在你原本关着时才关闭，不会动你手动开启的代理/TUN；`disable` 则会无条件关闭。
- 节点失效、订阅过期等需要你在 NinjaDesktop 里处理，插件不替你换节点。

## 许可证

MIT
