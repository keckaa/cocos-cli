# 动画资源库格式

Creator 3.8.8 的独立 `.anim`、glTF 原始动画和 glTF 子动画统一使用动态序列化的 CCON 二进制资源。独立动画与 glTF 子动画的库文件为 `<uuid>.bin`，其 `.meta.files` 记录唯一的 `.bin`；glTF 原始动画存放在父资源库目录的 `__original-animation-<index>.bin`，父资源仍可包含其它产物。`deserialize._macros` 只表示编译型序列化能力，不用于判断动态序列化能否写 CCON。

单独的 `.bin` 是资源导入数据，不是 native 文件。导出数据须将它作为 `buffer` import；若资源同时包含 `.json` 和 `.bin`，则 `.json` 仍是导入数据、`.bin` 按 native 文件处理。3.8.8 引擎收到 `.cconb` URL 时会请求对应的 `.bin`。

更改这些格式约定时，要同时核对动画序列化、依赖 UUID 提取、默认导出数据及引擎加载路径。动画 importer 的 `versionCode` 用于触发旧库缓存重导；不要手动改写 `.meta` 或清空整个项目的 `library/`。

独立动画与 glTF 子动画在成功写入库文件后，清除自身持久化的 `output` 导出缓存。AssetDB 因 importer 版本变化启动重导时会移除旧库文件，但可能保留旧 `output`；只提高 `versionCode` 会让后续预览或构建继续指向已删除的 `.json`。清理仅限这两个动画导入器，下一次导出按当前 `.meta.files` 重新生成路径。

针对配置引擎的回归测试：

```sh
node node_modules/jest/bin/jest.js --config jest.config.ts --runInBand --runTestsByPath src/core/assets/test/serialize-library.test.ts
```

测试在独立 Node 进程中加载本机配置的真实 Creator 3.8.8 引擎及 CLI preload，只读引擎配置，在系统临时目录中创建与清理资源，不打开开发工程。覆盖动态动画曲线/事件的重复往返、JSON/CCON/二进制及非零 byteOffset 的 UUID 依赖提取、独立 BIN 与 JSON+BIN 的导出分类、独立动画和 glTF 子动画的 JSON→BIN 重导及旧导出缓存迁移。版本变化后的默认导出、带选项导出及直接输出查询都必须返回新的 BIN 路径。

源码修改后，在 cocos-cli 仓库运行 `node node_modules/typescript/bin/tsc -b` 更新本机 `dist`，并重启使用该仓库的 MCP 服务。不要在游戏工程运行此编译命令。其他机器需更新 cocos-cli 并编译后重启服务；仅更新游戏工程不会包含这项导入器修复。

真实 Creator 互操作验收：在独立测试工程用同一份 `.anim` 执行 MCP→Creator→MCP 重导，核对 `.meta.files` 始终为 `[".bin"]`、UUID 与导入设置不变，并确认动画播放、预览及构建。真实引擎宿主回归不等同于完成这一编辑器验收。

## 2026-11-17 修复与验证记录

直接在 `3.8.8` 主工作树实现，Git 基线 `39c5a7e`。开始前将五项无关变更备份到系统临时目录并恢复到 HEAD：`package.json`、`package-lock.json` 是兼容数据库依赖更新与排序变化；`packages/cocos-cli-types/__tests__/__snapshots__/dts-snapshot.test.ts.snap` 是类型重新生成；`packages/cocos-cli-types/package.json`、`static/web/polyfills.bundle.js` 为换行/工作区状态噪声。这些内容不纳入动画修复。

- `node node_modules/typescript/bin/tsc -b`：退出码 0，本机 `dist` 已更新。
- 上述真实引擎回归：5/5 通过。新增旧 `output` 迁移断言时，独立动画、glTF 子动画两项先准确复现旧 JSON 路径错误，清缓存后通过。
- `npm test -- --silent --json --outputFile=<临时目录>/cocos-cli-animation-final-results.json`：279 个套件中 269 通过、10 失败；3234 个用例中 3183 通过、51 失败；包含本次 5 项回归全部通过。
- 用 `git archive HEAD` 创建独立临时源码副本，复用本机依赖、引擎、生成类型及既有编译产物，重跑这 10 个失败套件。原版本也有相同的 10 个失败套件、51 个失败用例；逐个比较套件路径和用例名称集合，无新增或消失的失败。全量测试仍为失败状态，未将这些既有失败视为已解决。
- `git diff --check` 通过；清理测试改写的 fixture `package.json` 与 `settings/cocos.config.json`。未修改游戏工程资源或 `.meta`，未执行真实 Creator 界面往返、动画播放或正式包构建验收。测试服务已退出。

既有失败范围：

- `src/core/assets/test/operation-filesystem-bridge.test.ts`（37 项）、`src/core/assets/test/delete-asset-options.test.ts`（2 项）：查询接口 mock 不完整，初始化时读取未定义的 `bind`。
- `src/core/assets/test/operation.test.ts`（2 项）：TextureCube 类型期望与实际 `cc.Asset` 不符。
- `src/core/assets/test/query.test.ts`（1 项）：internal SceneAsset 数量期望与实际不符。
- `src/core/builder/test/execute-build-stage-task.spec.ts`（1 项）：构建阶段回调参数断言不符。
- `src/core/scene/test/service-core/component-prefab-ui-handling.test.ts`（4 项）：组件管理器 mock 缺少 `getPathFromUuid`。
- `src/core/scene/test/scene.test.ts`（4 项）：两个脚本代理查询和两个 Prefab undo/redo 断言失败。
- `src/core/scene/test/editor-close-options.test.ts`、`src/core/scene/test/node-create-assets.test.ts`：引擎 mock 缺少 `CCClass.Attr` 或 `Prefab._utils`，套件初始化失败。
- `tests/simulator-runtime.test.ts`：缺少 simulator `import-map.json` 编译产物，套件初始化失败。

详细临时日志为 `cocos-cli-animation-final-test.log`、`cocos-cli-animation-final-results.json`、`cocos-cli-animation-baseline-test.log`、`cocos-cli-animation-baseline-results.json`；原五项的备份目录前缀为 `cocos-cli-before-animation-fix-`。临时记录保留供本机复核，长期行为以本文前半部分为准。

## 2026-11-17 总体复核补充

- 重新执行 TypeScript 构建与 5 项真实引擎回归，退出码均为 0。
- `npm run test:asset-db`：退出码 0；覆盖实体资源 `VERSION_CODE` 升级、仅虚拟子资源版本升级及重启缓存恢复。保留原有 4 项 pending 用例。
- 将实际游戏工程的全部 16 份 `.anim` 及导入设置只读复制到独立临时目录，在真实 3.8.8 引擎中逐份模拟旧 JSON 库及旧 `output`，每份 reset→import 两次，共 32 次导入成功。核对每次均只输出 BIN、UUID 不变、默认导出指向 BIN，动画 duration/sample/speed/wrapMode、事件、轨道数与源动画一致；反序列化 BIN 中的 UUID 依赖集合与源文件一致，包括序列帧动画每份 14～33 个外部引用。原文件与 `.meta` 的 SHA-256 前后相同，测试临时目录已清理。
- 重新读取原始版本与最终全量测试 JSON，确认失败套件路径和 51 个失败用例名称集合完全一致。本轮未修改实现代码，因此没有重复运行同一套全量测试。
- 本轮补正本文对 glTF 原始动画库路径的表述；未扩大实现范围。真实 Creator 界面往返、实际播放与正式构建仍待环境验收。
- 独立只读审查未发现可操作缺陷或阻塞项。现有 glTF 子动画回归对原始动画加载使用受控结果，另行验证了真实 `.cconb` 文件下载与反序列化；完整 glTF 父资源导入→子资源再生成仍是验证覆盖缺口，不能将当前结果解释为已完成该端到端验收。

## 2026-11-18 提交前同步验证

提交前将 `3.8.8` 快进至远端基线 `2b74913`，保留上游资源移动路径规范化等改动，本次修复无冲突恢复。

- TypeScript 构建退出码 0；真实引擎专项回归 5/5 通过；AssetDB 全套退出码 0，保留原有 4 项 pending。
- 在最新基线上重新运行全量测试：279 个套件中 269 通过、10 失败；3234 个用例中 3183 通过、51 失败。失败套件路径与失败用例名称集合和上一轮完全一致，没有新增失败。
- 本轮全量结果及日志为系统临时目录中的 `cocos-cli-animation-prepush-20261118-results.json`、`cocos-cli-animation-prepush-20261118-test.log`。清理两个 fixture 配置文件的测试换行变化，仅提交动画实现、专项测试与本文；编辑器互操作验收范围不变。
