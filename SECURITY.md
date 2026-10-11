# 本机运行与公开源码

模型会看到外部消息和网页，它们不是维护者指令。QQ 聊天预设应保持受限工具、白名单、按会话令牌、只读资料查询和发送额度；不要为了兼容测试而开放 shell 或删除工具守卫。

控制台是本机管理界面，支持查看私密状态并修改设置，不应暴露到公网。closed-agent 是管理员用途的独立模式，不能随意授权给普通 QQ 成员。私聊/群聊按 QQ 身份衔接，不按昵称合并；保密及仅私聊约定仍保留。学习执行限于维护者预设的固定例子，不接受聊天文本作为任意代码。

Git 忽略规则与 release:check 是发布辅助，不能证明所有信息都没有泄漏，也不能保护已经提交的历史。首次发布前检查暂存区和角色卡；发现凭据已提交时先使该凭据失效，再按 GitHub 的敏感数据处理流程清理历史。报问题请提供脱敏的错误、时间和组件版本，不要在公开 issue 贴原始配置或聊天记录。

发布检查参考：[GitHub 忽略文件](https://docs.github.com/en/get-started/git-basics/ignoring-files)、[敏感数据处理](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)。
