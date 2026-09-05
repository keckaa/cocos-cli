# Prefab 旧内存覆盖磁盘手改 — 设计

日期：2026-09-05  
状态：已落地

## 1. 问题

同一套 Cocos Creator 3.8.8 工程里，官方 CLI/MCP 与 Creator 编辑器同时改 prefab。典型流程：

1. `psd-to-cocos` 通过 MCP 创建并保存 prefab。
2. 用户在 Creator 里手改并保存该 `.prefab`。
3. 之后再次跑 `psd-to-cocos`（绝大多数），或其它 MCP scene 操作（少数）。
4. 手改被回退到 MCP 更早的版本。

根因不是「MCP 进程还在」，而是两件事叠在一起：

- **MCP 编辑器把打开后的节点树当权威数据。** `scene-save`、默认 `scene-close`、打开另一份资源时的自动关闭，都会把内存序列化写回磁盘，不比 mtime、不看 dirty。
- **`psd-to-cocos` 全程不调用 `scene-close`。** 转换结束后，当前打开的通常是最后挂过组件的那份 prefab。下一次 `scene-open` 临时场景时，MCP 会先 `close({ save: true })`，把旧内存盖掉 Creator 已经写过的文件。

主路径（A）的写盘发生在**第二次转换开头** `scene-open` 临时场景的瞬间，看起来完全不像在动用户刚改的那个 prefab。

## 2. 目标 / 非目标

### 目标

- 挡住主路径 A：上一次转换留下打开的、已保存（dirty=false）的 prefab，Creator 手改磁盘后，下一次 `scene-open` 不得把旧内存写回该 prefab。
- 挡住同类路径 B：任意后续 `scene-open` / 默认保存的 close / 显式 `scene-save`，在磁盘已比编辑器上次加载/保存更新时，不得静默覆盖。
- 不破坏「MCP 改了但还没显式 save，接着 open 另一份资源」时，把未保存编辑写盘的现有便利（仅当磁盘未被外部更新）。

### 非目标（本设计不做）

- 不把 Creator 手改实时灌进 MCP 当前打开的编辑器（`PrefabEditor._doReload` / `SceneEditor._doReload` 仍从内存重建，另开任务）。
- 不改 `apply-prefab-changes` 用场景内旧实例写回 prefab 资产的语义（不是主路径 A）。
- 不让 MCP 与 Creator 做协同锁/文件锁。
- 不改 Creator 编辑器本身。
- 不在本仓库未获授权时修改 `psd-to-cocos` skill 代码；skill 作为独立工作流写在第 7 节，实施需用户明确授权。

## 3. 方案选择

已否决：只改 skill。能覆盖常规 A 的收尾，挡不住其它 MCP 客户端，也挡不住「上一次转换已留下打开 prefab、本次转换开头就覆盖」之前已经发生的 MCP 行为；真正写文件的是 MCP。

已否决：只改 MCP 且只改 close 默认值。显式 `scene-save`（skill 挂组件后、或路径 B）仍可能覆盖更新的磁盘。

采用：**MCP 根因修复 + skill 收尾卫生（独立授权）**。

- MCP 即使 skill 漏 close，也不会用旧内存盖更新的磁盘。
- skill 用完 close，避免长期占着当前编辑器。

## 4. MCP 设计

改动集中在 `EditorService` 的打开/关闭/保存生命周期，不改 prefab 序列化格式。

### 4.1 记录源文件版本

在当前编辑器会话上记录 `sourceRevision`：

- 字段：`mtimeMs: number | null`，`size: number | null`，来自 `IAssetInfo.file` 的 `stat`。
- 写入时机：`open` 成功之后；`save` / `saveAs` 成功之后。
- `reload`（现行从内存重建）**不**更新 revision：内存仍是旧树，磁盘若已变，revision 必须继续反映「编辑器内容对应的那次加载/保存」，才能在下次保存时发现磁盘更新。
- `stat` 失败：revision 记 `null`。后续比较时视为「无法判断磁盘是否更新」，见 4.3。

可参考 `animation-graph-variant.ts` 已有的 query-then-mtime 拒绝保存，但 scene/prefab 的权威对象是编辑器内存树，revision 挂在 `EditorService` 会话上，而不是挂在 dump 查询结果上。

### 4.2 隐式关闭（open 另一份资源）

现行 `openUnlocked` 在打开新资源前：

```ts
await currentEditor.close({ save: Boolean(currentAssetInfo) });
```

改为调用 `shouldSaveOnSwitch(currentAssetInfo)`：

| 当前资源 | dirty（`Undo.isDirty()`） | 磁盘比 `sourceRevision` 新 | close.save |
| --- | --- | --- | --- |
| 已删除 / query 不到 | — | — | `false`（保持现状） |
| 存在 | `false` | 任意 | `false` |
| 存在 | `true` | 否 | `true`（保持「切换前自动保存未提交编辑」） |
| 存在 | `true` | 是 | `false`，打 warn，不抛错 |
| Undo 服务不可用 | — | 否 | `true`（兼容旧测试/早期启动） |
| Undo 服务不可用 | — | 是 | `false`，打 warn |

主路径 A 落在「存在 + dirty=false」：`psd-to-cocos` 最后一次 `scene-save` 会 `markSaved()`，因此第二次转换的 `scene-open` 不再写回那份 prefab。

dirty 且磁盘已新时不抛错：第二次 `psd-to-cocos` 必须能继续建临时场景。代价是 MCP 侧未保存编辑会随关闭丢掉；这比覆盖 Creator 手改更可接受。打 warn 便于排查。

### 4.3 真正写盘前的护栏

所有把当前编辑器内存写到当前资源的路径（`PrefabEditor.save` / `SceneEditor.save`，以及 `close({ save: true })` 触发的 save）在 `saveAsset` 之前检查磁盘：

- 若 `sourceRevision` 完整，且当前文件 `mtimeMs` 或 `size` 与记录不一致：视为外部已改。
- **显式保存**（MCP `scene-save`）：抛错，不写盘。错误信息须包含资源 url，并说明磁盘已在编辑器上次加载/保存之后被修改，需要先 `scene-close`（不保存）再 `scene-open`，或先确认要覆盖。v1 **不**加 force 开关。
- **显式 close 且请求 save**：若编辑器 dirty（或 Undo 不可用）且磁盘已新 → 抛错，不写盘，也不关闭（避免静默丢掉未保存编辑）。若编辑器干净且磁盘已新 → **不抛错、不写盘，正常关闭**，避免 MCP `scene-close` 无法传 `save:false` 时把会话卡死。
- **隐式关闭触发的保存**：不会走到这里仍要覆盖的情况，因为 4.2 已把 `save` 设为 `false`。若实现上仍调用了 save，同样拒绝写盘，但隐式路径只 warn、不让整个 `scene-open` 失败。
- revision 为 `null` 或 `stat` 失败：不拦（避免把 MCP 正常保存打挂），依赖 4.2 的 dirty 判断挡主路径。

`saveAs` 写的是另一个 uuid，不按「当前资源磁盘变新」拦截。

### 4.4 显式 close 默认值

MCP `scene-close` 仍不传 `save`，底层默认仍是 `true`（兼容旧调用方）。干净编辑器 close 会跳过写盘并关闭（磁盘是否已变都如此）。dirty 且磁盘已新的 close 按 4.3 抛错。

为少一次无意义写盘：`close({ save: true })` 且 `!isDirty()` 且磁盘未变时，可以跳过 `saveAsset`，直接卸编辑器。这是优化，不是正确性必要条件。

### 4.5 不在本设计改动的 MCP 行为

- `create-prefab-from-node` / `apply-prefab-changes`：仍从当前场景节点树生成 prefab 内容。它们写的是「现在这棵实例」，不是「当前打开的 prefab 文档的旧内存」。主路径 A 不经过它们去覆盖上一次转换留下的 prefab 文档。
- `scene-reload`：继续从内存重建。文档/工具描述若写「从磁盘重载」，另开任务修正实现或文案。
- 不新增文件 watcher 把 Creator 手改自动灌进当前编辑器。

## 5. 错误与日志

- 隐式关闭因磁盘已新而跳过保存：`console.warn`，带当前资源 url 与「source file newer than editor session」。
- 显式 `scene-save` 因磁盘已新而失败：MCP 工具返回 `code != 200`，`reason` 用中文可读说明。
- 不在成功路径打 info 刷屏。

## 6. 测试（MCP）

优先扩现有编辑器生命周期测试，不新开 e2e 也能锁住主路径。

必须覆盖：

1. `open` 另一资源时，当前编辑器 `isDirty() === false` → `close({ save: false })`。
2. `open` 另一资源时，当前 dirty 且磁盘未变 → `close({ save: true })`。
3. `open` 另一资源时，当前 dirty 且源文件 mtime/size 已变 → `close({ save: false })`，新资源仍能打开。
4. 资源已删除时 `open` 另一资源 → 仍 `close({ save: false })`（现有用例保持）。
5. 显式 `save()`：打开后磁盘 mtime 被改 → save 抛错，不调用 `saveAsset`。
6. 显式 `save()`：打开后未改磁盘 → 仍保存并更新 revision。
7. 现有 `editor-close-options`：close 默认仍会走 save 请求；若 `!dirty` 且磁盘未变，允许变成跳过写盘，但 `save: false` 仍必须不写盘。
8. 显式 close：干净编辑器 + 磁盘已新 → 不抛错，`close({ save: false })`。
9. 显式 close：dirty + 磁盘已新 → 抛错，不调用 editor.close / save。

`message-callsite.test.ts` 里「concurrent opens → firstEditor.close({ save: true })」在引入 dirty 判断后：该用例未模拟 dirty，应变为 `save: false`，或给 Undo mock `isDirty: true` 以保留「切换时保存未提交编辑」的断言。不要静默留着过期期望。

## 7. Skill 设计（独立工作流，需授权）

路径：`client/.claude/skills/psd-to-cocos`。本仓库实施 MCP 时**不要**顺手改 skill。

建议：

1. `attachComponentToPrefab` 在最后一次 `scene-save` 之后调用 `scene-close`。因刚保存过，传底层 `save: false` 更安全（若 MCP `scene-close` 仍不能传 save，则 close 默认 save 也会被 4.3 拦住，只要磁盘未被外部改）。当前 MCP `scene-close` 无 `save` 参数：skill 侧可先调 close；MCP 落地 4.4 的「未 dirty 跳过写盘」后即可。
2. `__delete_scene__` 在 `assets-delete-asset` 之前尽量先 close 临时场景（best-effort，失败不中断转换），避免删的是当前打开资源。
3. 单测：`generate-prefab.plan.test.js` / attach 相关测试断言收尾出现 close；`generate-prefab.plan.test.js` 里 `__delete_scene__` 仍在 create-prefab 与 scene-save 之后。

skill 只解决「不要把枪上膛」；不能替代第 4 节。

## 8. 风险

- 依赖「open 另一资源必会把未保存编辑写盘、且不管磁盘」的脚本会看到行为变化。合法未保存编辑 + 磁盘未变时仍会保存。
- 显式 `scene-save` 在 Creator 已写盘后会失败。这是要的；调用方需 close（不保存）再 open。
- FAT/网络盘 mtime 精度：用 `mtimeMs` + `size`。极端同秒同大小的外部改动可能漏检；主路径是 Creator 正常保存，mtime 会变。
- 不修复「MCP 与 Creator 同时打开同一 prefab 时 Creator 自己的内存盖盘」。那是编辑器侧问题。

## 9. 实施顺序

1. MCP：`shouldSaveOnSwitch` + 生命周期单测（先挡住 A）。
2. MCP：`sourceRevision` + 写盘前检查（挡住 dirty/显式 save 的同类覆盖）。
3. 用户授权后：skill 收尾 `scene-close`。

## 10. 验收

- 复现 A：转换 prefab → Creator 手改并保存 → 再跑一次 `psd-to-cocos`（其它界面或重转）→ 该 `.prefab` 手改仍在。
- 路径 B：转换后 MCP 仍开着 prefab → Creator 手改 → 再 `scene-open` 其它资源 → 手改仍在。
- 未保存的 MCP 编辑 + 磁盘未变 + `scene-open` 其它资源 → 未保存编辑仍写入磁盘（旧便利保留）。
- `psd-to-cocos` 自身生成/挂组件/落盘仍通过现有 generate 单测与一次真实转换抽检。
