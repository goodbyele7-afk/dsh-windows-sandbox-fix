# 发布到 GitHub

仓库：<https://github.com/goodbyele7-afk/dsh-windows-sandbox-fix>（空仓库，`main` 分支）
本地：已 commit，remote 已配好，只差一次带凭据的 push。

---

## 这台机器的三个坑（脚本里都绕开了）

### 坑 1：`git` 不在 PATH 里

你看到的 `无法将"git"项识别为 cmdlet` 就是这个。本机没装独立 Git，
唯一的 git 藏在 DSH ops 的运行时里：

```
C:\Users\Administrator\.dsh\dsh-ops\bash-ipc\7fc7dde8edb4a132c2563709\ucrt64\bin\git.exe
```

`push.cmd` / `push.ps1` 里写死了这个路径，实测能找到（2.56.0）。

### 坑 2：Git Credential Manager 一启动就崩

系统配置 `credential.helper=helper-selector` 指向的 `git-credential-manager.exe`
在这台机器上启动即抛异常退出（`exit -532462766`），**不会弹浏览器登录**。

脚本里加了 `-c credential.helper=` 清掉这个配置，改成在窗口里直接问你账号密码。

### 坑 3：到 github.com:443 的链路不稳

实测 5 次里 1 次成功、4 次 `Could not connect` / `Connection was reset`（每次卡 21 秒）。
注意 `api.github.com` 一直是通的（200），只有主站抖。

脚本里加了**自动重试 5 次**，间隔 4 秒。

---

## 方式 A：双击脚本（推荐）

| 脚本 | 怎么用 |
| --- | --- |
| [push.cmd](push.cmd) | 双击 |
| [push.ps1](push.ps1) | `powershell -ExecutionPolicy Bypass -File .\push.ps1` |

运行时按提示输入：

- **Username**：`goodbyele7-afk`
- **Password**：一个 **Personal Access Token**（不是账号密码）

建 token：<https://github.com/settings/tokens/new>
→ Expiration 选 7 days → 勾 **`repo`** 整类 → Generate → 复制 `ghp_...`

> 也可以用 fine-grained token：
> <https://github.com/settings/personal-access-tokens/new>
> → Only select repositories → `dsh-windows-sandbox-fix`
> → Permissions: **Contents: Read and write**

---

## 方式 B：复制到 PowerShell（注意整行，别换行）

```powershell
cd "D:\新建文件夹\你好 - DeepSeek_files\新建文件夹 (2)\dsh-windows-sandbox-fix"

$g = "C:\Users\Administrator\.dsh\dsh-ops\bash-ipc\7fc7dde8edb4a132c2563709\ucrt64\bin\git.exe"; $env:GIT_TERMINAL_PROMPT = "1"
& $g -c credential.helper= push -u origin main
```

报 `Could not connect` 就**原样再执行一次**，链路是间歇的，多试几次能过。

---

## 方式 C：纯网页上传（网络一直不通时的兜底）

走的是 `api.github.com`，实测稳定：

1. 解压 [dsh-windows-sandbox-fix.zip](dsh-windows-sandbox-fix.zip)
2. 打开 <https://github.com/goodbyele7-afk/dsh-windows-sandbox-fix/upload/main>
3. 把解压出来的文件拖进去，Commit

会丢 git 历史，文件内容完全一样。

---

## 推完之后

1. 确认 <https://github.com/goodbyele7-afk/dsh-windows-sandbox-fix> 能看到 README
2. 去 <https://github.com/deepseek-ai/deepseek-harness/discussions/10066> 贴
   [docs/upstream-report.md](docs/upstream-report.md) 的正文，末尾附你的仓库链接
   （那个仓库 `has_issues: false`，只开 discussions，别开 issue）
