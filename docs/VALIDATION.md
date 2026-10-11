# 2026-10-11 审查与发布验收

## 当前确认与未解决

控制台保存备用外号原本访问不存在的路径，现改为真实接口；人物、梗、好感三个面板共用称呼来源，区分双方称呼、备用、停用和作用范围。修正删外号误删其他个人用语、刷新覆盖草稿、读人物创建私聊会话、梗计数没落盘及私聊表达自动外溢到公开梗池。

分数94通常是小数取整，本次现场核到94.24。上限仍按配置初始50+45=95；每日计分限制明确显示。修正触顶后的手动减分被隐藏溢出抵消，以及一个加减按钮发送两次请求。现场验收还发现原回落规则与说明、行为计分不一致，现统一有效分数并显示基础与回落。保留原计分规则，没有改到100。

历史人物补齐不再按同名合并档案，也不再修改已失效的历史分数字段；重复补齐只恢复名单/消息量，原数据保留。

仍未解决：安装的 DSH 工具名检查找不到 dsh_snapshot、dsh_rollback、incident_resolved，与此前版本相同。对应守卫保持，不删检查凑全绿。bridge.js 仍有历史重复实现和较大单文件，后续需逐步拆分。未现场重新测试所有外部服务、空间写入、语音或所有真实聊天风格，不能称为功能全部完善。

## 怎样理解测试

npm run test:portable 运行40组隔离工程测试，刻意不代替安装版本工具名对账。npm run test:review 还运行该兼容性检查；本机完整结果为40/41。工具名是否覆盖所有真实注册能力，需要结合目标 DSH 安装及运行时检查。

npm run test:console-ui 需要自行安装 Playwright/Chromium，或通过 PLAYWRIGHT_MODULE 与 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 指定可用路径；页面连模拟服务，38项检查覆盖交互契约、异常/转义、导航、刷新及编辑。Mock 浏览器检查之外，新增测试使用真正桥接 HTTP API 验证外号、分数与身份隔离；部署后也需要只读核对正式三个面板。

这轮已升级锁文件中的 MCP SDK 至1.31.0，proxy-addr 至2.0.8。npm audit 报告当前0项已知漏洞，代表数据库所知依赖问题的检查，不代表源码绝对安全。MCP公告说明 stdio 客户端及服务器不受该 OAuth 客户端漏洞影响，本项目主要使用 stdio；升级没有声称已遭利用。参考：[MCP SDK 维护者公告](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h)、[proxy-addr 公告](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)。

发布目录是白名单复制的源码，非运行目录备份。发布清单和校验结果见 RELEASE-MANIFEST.json；真实配置、状态、Cookie、聊天记录、维护日志和第三方程序没有打包。上传前还需审查所选账号、仓库名和暂存文件。

## 整理副本的实际验收

全新安装后40/40组隔离工程测试通过；整理副本控制台38/38项浏览器检查通过；这轮修正针对测试36/36通过。正式运行的6个人物在三个面板一致，MCP工具架构45项读取成功，没有给真实QQ发送验收消息。源码整理副本 npm audit 为0项已知漏洞。GitHub CI已经开始运行，具体提交的远端结果见仓库 Actions。

两组实际学习练习测试需要 Python 3，通过 QQ_BRIDGE_PYTHON 或 PATH 选择解释器，不依赖开发机的固定安装路径。CI明确准备 Python；实际执行、缺失解释器、超时和结果落盘的检查保留。离线预览不需要 Python。工作流的 Python 环境配置参考 [setup-python 官方说明](https://github.com/actions/setup-python)。

发布检查直接读取暂存区，能够发现“只改工作区而没更新暂存区”的残留假Cookie；临时仓库拦截验证已通过。通用扫描不涵盖所有私密自然语言，首次发布仍要人工检查角色卡。CI配置参考 [checkout](https://github.com/actions/checkout) 和 [setup-node](https://github.com/actions/setup-node) 的官方说明。
