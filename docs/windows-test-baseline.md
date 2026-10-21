# Windows 开发机测试基线（2026-10-21）

## 结论

在 Windows 开发机上跑全量 vitest，**868 例中固定 22 例失败、846 例通过**（`28bc57a`，2026-10-21 复核）。
这 22 例全部可追溯到 Windows 平台机制，与代码改动无关：跨批次 1 / 3 / 4 三次全量运行，
总数从 862 → 867 → 868 递增（每次只新增用例），失败数始终是 22、失败文件集合始终相同。
**任何偏离本名单的失败都应视为回归，先怀疑自己的改动。**

## 基线数据

| 测试文件 | 失败数 | 分组 |
| --- | --- | --- |
| `server/output-download.test.ts` | 8 | 路径分隔符 5 + 超时 3 |
| `server/plugin-manager.test.ts` | 6 | EBUSY 4 + 权限位 2 |
| `plugins/live-recorder.test.ts` | 5 | ffmpeg PATH shim 失效 |
| `plugins/onlyfans/index.test.ts` | 2 | 权限位 1 + 路径分隔符 1 |
| `scripts/easyx-ofscraper-download.test.ts` | 1 | 缺少 ofscraper 二进制 |
| **合计** | **22** | |

复现命令（仓库根目录）：

```
node node_modules/vitest/vitest.mjs run
# 期望结尾：Test Files 5 failed | 102 passed (107)
#           Tests  22 failed | 846 passed (868)
```

## 失败分组与根因

### 1. POSIX 权限位不存在（3 例）

`expected 438 to be 384` —— 测试断言 `chmod 0600` 后 `statSync().mode` 的低位是 `0o600`（384）。
NTFS 不存储 POSIX 权限位，Windows 上 `fs.statSync` 对可写文件一律返回 `0o666`（438）。

- `plugin lifecycle stores imported account sessions privately and removes them on uninstall`
- `plugin lifecycle preserves imported raw JSON sessions for plugins that need structured authentication`
- `OnlyFans plugin creates a private, self-contained OF-Scraper profile`

### 2. 路径分隔符（6 例）

`expected 'Alice\example.test-original.mp4' to be 'Alice/example.test-original.mp4'` ——
`path.join` 在 Windows 上产出反斜杠，测试按 POSIX 写法硬编码了正斜杠。

- `custom download output writes directly into a model folder and keeps the library's source metadata`
- `custom download output produces a playable live recording` × 4（source / h264-high / h264-small / h265 预设）
- `OnlyFans plugin uses a real, read-only OF-Scraper authentication check`（断言 ofscraper 配置路径匹配 `/ofscraper\/config\.json$/`，实际拿到 `C:\Users\...\Temp\...`）

### 3. Windows 文件锁（4 例）

`EBUSY: resource busy or locked, unlink 'C:\...\Temp\easyx-plugin-...'` ——
Windows 上刚写入的临时目录无法立即递归删除（句柄未释放 / 索引器占用）；Linux 的 unlink 无此限制。
四例均为 `plugin lifecycle` 下创建即删的临时目录用例。

### 4. 慢速文件系统超时（3 例）

- `custom download output rejects a symlinked destination...`（5s 超时）
- `custom download output preserves the captured source for recovery if encoding fails`（5s 超时）
- `custom download output encodes and saves a manually stopped recording`（Download timed out）

本机实测 `output-download.test.ts` 单文件耗时 49 秒，远超 CI runner。属于磁盘延迟，不是逻辑错误。

### 5. 缺少 ofscraper 二进制（1 例）

`Error: spawn ofscraper ENOENT` —— ofscraper 只装在容器镜像里（`/opt/ofscraper/bin`），
Windows 开发机没有。`scripts/easyx-ofscraper-download.test.ts` 整条链路依赖它。

### 6. live-recorder 的 ffmpeg PATH shim 在 Windows 上不可能生效（5 例）

现象：5 例全部报 ffmpeg 的 `Not detecting m3u8/hls with non standard extension and non standard mime type`。

**根因不是 ffmpeg 版本差异，而是测试基建**：`live-recorder.test.ts` 往临时目录写一个
**无扩展名的 shebang 脚本** `bin/ffmpeg` 并把它插到 PATH 最前面，指望 `spawn("ffmpeg")` 命中它。
POSIX 上这没问题；Windows 上这条链断得很死（2026-10-21 实测三种变体）：

| 变体 | 结果 |
| --- | --- |
| `bin/ffmpeg.cmd` 置于 PATH 最前 | 输给后位 PATH 里的真 `ffmpeg.exe` |
| 追加 `bin/ffmpeg.bat` | 同上 |
| 追加无扩展名 `bin/ffmpeg` | 同上 |
| 直接 `spawn("ffmpeg.cmd")` | Node 抛 `EINVAL`（无 shell 不允许 spawn 批处理） |

机制：libuv 在 Windows 上的 PATH 搜索只接受 PE 可执行文件（批处理/脚本类候选被跳过），
而显式 spawn `.cmd` 又被 Node 拒绝。**结论：只要 PATH 里任何位置存在真 `ffmpeg.exe`，
Windows 上就不可能用 PATH shim 拦截 `spawn("ffmpeg")`。** 于是真 ffmpeg 上场，
对着测试用的假流（无 Content-Type 的 `.m3u8`）必然失败。

真正的修法（本轮未做，见「后续建议」）不是继续补 shim 变体，而是让 recorder 的 ffmpeg
路径可注入（如 `EASYX_FFMPEG` 环境变量），或把这 5 例在 Windows 上显式 skip 并注明原因。

## Linux 侧信号现状（重要）

这 22 例的「Windows 特性」判断中，前 5 组（20 例）的机制是自明的；
唯一没有直接 Linux 复跑证据的是 live-recorder 5 例。**目前没有任何可用的 Linux 通道**：

- CI 的 `Fast checks / publish` 自 9 月中旬起持续失败（本次核查到的最早记录为 9 月 14 日 #29），
  每次都在约 1 分钟内挂断 —— 远早于 docker smoke 阶段，是 vitest 步上的
  `output-download` 超时（GitHub runner 磁盘慢，与本地第 4 组同源）。
- 也就是说 CI 的 vitest 步已经红了一个多月，**所有测试文件在 Linux 上的通过情况都无法从 CI 观测**，
  `/browser` 相关的 docker smoke 断言同理从未真正跑到（详见 `28bc57a` 提交说明）。
- 本机无 docker；VPS2 是 1 核 / 1GB 空闲且正在录制的生产机，不适合跑 `npm ci` + 全量 vitest。

## 使用方法

1. 每次全量跑完后与上表对 diff：**失败集合必须是这 22 个**（允许第 4 组超时例数在 2–4 间波动，
   磁盘状态差时 `output-download` 可能多挂一两例，属同一根因）。
2. 出现新失败 → 按代码改动回归排查，不要往基线里加。
3. 清掉某组环境因素后（如在开发机装 ofscraper、把临时目录移到内存盘），从表里划掉对应行并更新本文档。

## 后续建议（超出本轮范围，待排期）

1. `live-recorder.test.ts`：给 recorder 加 `EASYX_FFMPEG` 路径注入，或在 Windows 上
   `it.skipIf(process.platform === "win32")` 并引用本文档 —— 前者还能顺带覆盖生产环境的 ffmpeg 路径问题。
2. `output-download.test.ts`：为慢盘调大 `testTimeout`（或把 fixture 临时目录放到 `tmpfs`），
   本地与 CI runner 同时受益。
3. 权限位断言（3 例）与路径分隔符断言（6 例）按 `process.platform` 分支，让测试在两个平台上都真正断言有意义的东西。
4. `scripts/easyx-ofscraper-download.test.ts`：开发机安装 ofscraper，或在缺失时 skip 并提示。
5. CI 的 `output-download` 超时：runner 侧排查（换 `runs-on` 或加 `TMPDIR` 指向 tmpfs），
   否则 Linux 信号会继续缺失。
