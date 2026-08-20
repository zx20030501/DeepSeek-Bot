# Fleet v2 Mention Parser

## Syntax

`parseFleetMentions(text, options)` recognizes:

- `@bot-id` as a Bot target;
- `@team` or `@team:team-id` / `@team/team-id` as a Team target;
- `@manager` or `@manager:manager-id` / `@manager/manager-id` as a Manager target.

The parser preserves `rawText`, returns the cleaned `instruction`, de-duplicates
targets while preserving first-seen order, and separates `targets`,
`routableTargets`, and `unknownTargets`.

`routableTargets` is only a syntax/registry-level filter. It is not a substitute
for Gateway ACL and identity checks.

## Loop and budget metadata

The result carries:

- `hop` and `maxHop` enforcement;
- `visited` identities;
- mention budget and remaining budget;
- truncation diagnostics.

Self mentions and visited targets remain observable in `targets` but are removed
from `routableTargets` so the control plane can audit why they were not routed.

## Protected text

The parser ignores mention-like text inside fenced code, inline code, Markdown
links, URLs, `www` URLs and ordinary e-mail addresses. It rejects input above
the configured maximum rather than silently truncating arbitrary user text.

## Integration boundary

Codex should replace or wrap the current Gateway mention parser only after
mapping `MentionTarget` to the canonical Bot principal/ACL resolver. The
parser must not be allowed to dispatch directly, choose a session, mint a
credential, or modify a Team.

## 中文说明

Mention Parser 是纯解析模块，不是 Router。它可以识别 Bot、Team、Manager，
处理去重、顺序、循环 hop、visited 和 mention budget，并忽略 URL、邮箱、
Markdown 和代码块。但是“这个 Bot 能不能被当前用户调用”仍必须由 Codex
负责的 Gateway/ACL 层重新裁决。
