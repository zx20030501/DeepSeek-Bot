# DeepSeek-Bot PR Guardian

## English

## Purpose

PR Guardian is this repository's GitHub Actions automation reviewer. Its workflow is designed to:

1. Run deterministic CI first to validate TypeScript, tests, the client build, and npm packaging;
2. Have DeepSeek perform a structured review of the PR diff and publish a GitHub Check named `AI Review`;
3. Attempt a bounded number of low-risk automatic fixes only for repository-owned `agent/` branches;
4. Automatically rerun CI and AI Review after a fix commit;
5. Request GitHub Auto-merge only when the change is low risk, AI Review passes, and the PR is not a Draft;
6. Send workflows, dependency manifests, credentials, authentication, pairing, gateway, Transport, and security-boundary changes to human review by default.

AI Review is an automated gate, not a human GitHub approval. The repository Ruleset and required status checks still make the final merge decision.

## Enable AI Review

Open the following page in the repository:

~~~text
Settings → Secrets and variables → Actions → New repository secret
~~~

Create this repository secret:

~~~text
DEEPSEEK_API_KEY=your DeepSeek API key
~~~

Do not paste the key into source code, Issues, PRs, logs, or chat. The workflow reads the GitHub Actions Secret only and never writes the key to the repository.

Optional repository variables:

~~~text
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
~~~

If these variables are not set, the defaults above are used. If `DEEPSEEK_API_KEY` is missing, AI Review fails with a configuration message and deterministic CI continues, but the system will not auto-fix or auto-merge.

## Ruleset Configuration

The current `Protect main` ruleset already requires:

~~~text
test (22)
~~~

After PR Guardian has completed one successful run, add the following to the Required status checks in the same ruleset:

~~~text
AI Review
~~~

This prevents `main` from merging when AI Review fails even if someone attempts to invoke Auto-merge through another path. Configure `DEEPSEEK_API_KEY` first and let the workflow complete at least once before adding this check.

Also enable **Allow auto-merge** under Settings → General → Pull Requests. If it is disabled, the Auto-merge job stops and does not bypass the Ruleset.

The following settings are also recommended:

- Disable force pushes;
- Disable deletion of `main`;
- Require pull requests;
- Keep both `test (22)` and `AI Review` as required checks;
- Keep human review for high-risk files.

## Automatic-Fix Boundary

Automatic fixes run only when all of the following conditions are satisfied:

- The PR's head repository is this repository;
- The PR branch starts with `agent/`, for example `agent/feishu-card`;
- AI classifies the result as `fail` and every finding is marked fixable;
- The diff does not touch human-review paths;
- The automatic-fix count is below 2;
- The model-generated Git diff modifies only files already modified by the PR;
- `git apply`, `git diff --check`, `npm ci --ignore-scripts`, and `npm test` all pass.

Fix failures, out-of-scope patches, test failures, and the retry limit stop the workflow and leave an explanation in the PR conversation. External fork PRs can be read and commented on by AI, but this workflow never writes code to them.

## Auto-Merge Boundary

The first version enables GitHub Auto-merge only for low-risk, same-repository `agent/` branches on non-Draft PRs. It does not bypass the Ruleset or replace human review. GitHub waits until `test (22)`, `AI Review`, and every other required Ruleset condition has passed before merging.

High-risk paths include:

~~~text
.github/workflows/
.github/actions/
.github/pr-guardian.mjs
.github/pr-guardian-policy.json
package.json
package-lock.json
Any path containing credential, secret, security, auth, or pairing
src/feishu.ts
src/telegram.ts
src/gateway.ts
src/harness-bridge.ts
src/setup-security.ts
src/setup.ts
src/setup-route.ts
~~~

To adjust the scope, edit `.github/pr-guardian-policy.json` through a PR. Do not change the security policy while a workflow is running.

## Security Design

The review workflow uses `pull_request_target`, checks out only the trusted base branch, and reads external PRs as diff data without executing their code. The automatic-fix job checks out and tests a PR branch only when it belongs to this repository and starts with `agent/`.

Workflow permissions are separated by job: review receives permissions to read code and write Checks/comments; automatic fixing and Auto-merge request `contents: write`. All commits are created by the GitHub Actions bot identity and include a `[pr-guardian-fix: n/2]` marker to limit loops.

## Daily Use

Recommended branch naming:

~~~bash
git switch -c agent/my-change
git push -u origin agent/my-change
~~~

After opening a PR, the system triggers automatically. If you want human handling only, use a normal branch name; it will not receive automatic-fix or auto-merge permissions.

To disable the automation urgently:

1. Delete or rotate `DEEPSEEK_API_KEY`;
2. Temporarily disable the PR Guardian workflow;
3. Keep the `Protect main` Ruleset and the `test (22)` check.

## Large Data

PR Guardian writes only bounded diff summaries and review results to GitHub Checks/comments. It does not commit replays, diagnostic archives, load-test logs, or build archives to the repository. Large runtime artifacts remain in the project's designated Google Drive directory; this implementation did not generate any files that need to be uploaded.

---

## 中文

# DeepSeek-Bot PR Guardian

## 目的

PR Guardian 是本仓库自己的 GitHub Actions 自动化审核器，目标是把流程固定为：

1. 确定性 CI 先验证 TypeScript、测试、客户端构建和 npm 打包；
2. DeepSeek 对 PR diff 做结构化审核，并生成名为 AI Review 的 GitHub Check；
3. 仅对仓库内部、agent/ 前缀分支尝试有限次数的低风险自动修复；
4. 修复提交后自动重新触发 CI 和 AI Review；
5. 只有低风险、AI Review 通过、PR 不是 Draft 的情况下，才请求 GitHub Auto-merge；
6. 工作流、依赖清单、凭证、认证、配对、网关、Transport 和安全边界默认转人工审核。

AI Review 是自动化门禁，不是 GitHub 人工 Approve。最终合并仍由仓库 Ruleset 和必需状态检查决定。

## 启用 AI 审核

在仓库网页中打开：

~~~text
Settings → Secrets and variables → Actions → New repository secret
~~~

创建以下 Repository secret：

~~~text
DEEPSEEK_API_KEY=你的 DeepSeek API Key
~~~

不要把 Key 粘贴到源码、Issue、PR、日志或聊天中。工作流只读取 GitHub Actions Secret，不会把 Key 写入仓库。

可选的 Repository variables：

~~~text
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
~~~

不设置变量时使用上面的默认值。未设置 DEEPSEEK_API_KEY 时，AI Review 会失败并提示配置密钥；确定性 CI 仍会继续，但系统不会自动修复或自动合并。

## Ruleset 配置

当前 Protect main 已经要求：

~~~text
test (22)
~~~

第一次成功运行 PR Guardian 后，在同一个 Ruleset 的 Required status checks 中加入：

~~~text
AI Review
~~~

这样即使有人绕过工作流调用 Auto-merge，main 仍不会在 AI Review 失败时合并。添加该检查前，先配置 DEEPSEEK_API_KEY 并让工作流至少完成一次。

另外在 Settings → General → Pull Requests 中开启 Allow auto-merge；关闭时，Auto-merge job 会停止并不会直接绕过 Ruleset 合并。

同时建议保持：

- 禁止 force push；
- 禁止删除 main；
- 必须通过 Pull Request；
- 至少保留 test (22) 和 AI Review 两个必需检查；
- 对高风险文件保留人工审核。

## 自动修复边界

自动修复只满足以下条件时执行：

- PR 的 head 仓库就是本仓库；
- PR 分支以 agent/ 开头，例如 agent/feishu-card；
- AI 判定为 fail，且所有发现都标记为可修复；
- diff 没有触及人工审核路径；
- 自动修复次数未达到 2 次；
- 模型输出的 git diff 只修改本次 PR 已经修改的文件；
- git apply、git diff --check、npm ci --ignore-scripts 和 npm test 全部通过。

修复失败、补丁越界、测试失败或达到上限都会停止，并在 PR 会话中留下说明。外部 Fork PR 可以被 AI 阅读和评论，但不会被本工作流写入代码。

## 自动合并边界

第一版只对低风险、同仓库 agent/ 分支、非 Draft PR 启用 GitHub Auto-merge。它不会直接绕过 Ruleset，也不会替代人工审核。GitHub 会等待 test (22)、AI Review 以及 Ruleset 中其他必需条件都满足后再合并。

高风险路径包括：

~~~text
.github/workflows/
.github/actions/
.github/pr-guardian.mjs
.github/pr-guardian-policy.json
package.json
package-lock.json
包含 credential、secret、security、auth、pairing 的路径
src/feishu.ts
src/telegram.ts
src/gateway.ts
src/harness-bridge.ts
src/setup-security.ts
src/setup.ts
src/setup-route.ts
~~~

如需调整范围，编辑 .github/pr-guardian-policy.json，并通过 PR 修改；不要直接在工作流运行时改变安全策略。

## 安全设计

审核工作流使用 pull_request_target，但只检出可信的 base 分支，把外部 PR 当作 diff 数据读取，不执行外部 PR 的代码。自动修复 job 只有在同仓库 agent/ 分支上才会检出和测试 PR 分支。

工作流权限按 job 分开：审核使用读取代码和写 Check/评论的权限；自动修复和 Auto-merge 才申请 contents: write。所有提交都由 GitHub Actions 机器人身份产生，并带有 [pr-guardian-fix: n/2] 标记，便于限制循环次数。

## 日常使用

建议的分支命名：

~~~bash
git switch -c agent/my-change
git push -u origin agent/my-change
~~~

打开 PR 后，系统会自动触发。若只是希望人工处理，可以使用普通分支名，不会获得自动修复或自动合并权限。

需要紧急关闭自动化时：

1. 删除或轮换 DEEPSEEK_API_KEY；
2. 暂时禁用 PR Guardian workflow；
3. 保留 Protect main Ruleset 和 test (22) 检查。

## 大型数据

PR Guardian 只把有上限的 diff 摘要和审核结果写入 GitHub Check/评论，不把回放、诊断压缩包、压测日志或构建归档提交到仓库。大型运行产物继续按项目约定保存到 Google Drive；本次实现没有生成需要上传的文件。
