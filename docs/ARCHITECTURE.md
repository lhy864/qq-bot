# 代码怎样让她聊天

## 一次消息怎样走

src/bridge.js 连接 OneBot，收到消息后检查模式、白名单、对象身份，记入当前会话。它向 DSH 发出唤醒提示；DSH 中的 qq-chat-v2 预设让模型通过 src/mcp-snowluma-safe.js 查询提示/未读和调用发送工具。发送最终回到桥接，核验当前会话令牌、白名单、暂停与发送频率，再调用 OneBot。

## 人设和代码各管什么

roles/小鲸鱼.md 管性格主轴、兴趣、说话习惯；src/role-card.js 按模式取用，conversation-style.js 与 chat-expression.js 按当前意图附加少量表达提示。人设不能让不存在的记忆变成真事，增加提示也不能保证每一轮都好笑。

person-continuity.js 保存按 QQ 身份的称呼/相处约定 contracts 和具体讨论 threads；person-recall.js 从实际消息对产生有限话题索引 recaps。跨场景按身份、范围、时效和来源投射摘要，包含明确私聊限定的内容不会随意公开。social-continuity.js 管会话里的共同经历和约定。

console-consistency.js 汇总双方称呼方向、备用称呼、有效好感度与额度，桥接 API 和三个管理面板共用结果。本人约定优先于自动/控制台备用；停用和仅私聊不是“没记录”。界面改数据必须调用真正存在的后端路径。

## 后台日常怎样变成话题

leisure.js 负责空闲判断、每日尝试额度、材料队列、实际取得片段和笔记。material-conversation.js 将真实片段转换为易懂的作品/知识介绍与可讨论问题；reading-questions.js 跟踪疑问，learning-practice.js 运行维护者固定的练习。lived-experience.js 保存有依据的经历和观点，不能把笔记当成“看完全部”。daily-activity.js 按时段表达活动倾向，anime-progress.js 只推进模拟进度。

## 数据与维护

config.json 是本机设置；state 下的 sessions、persons、social-v2、memes、slang、leisure、anime 等保存各类状态。它们不属于源码。模型调用和后台任务可能计费；离线测试全部使用临时文件与模拟服务。热重启不能清空状态来掩盖错误。

bridge.js 仍包含历史重复函数和路由，实际生效位置需要确认。这轮只修正已验证的路径，没有完成整个模块拆分；后续应逐步移除重复实现并补真实 API 契约测试。
