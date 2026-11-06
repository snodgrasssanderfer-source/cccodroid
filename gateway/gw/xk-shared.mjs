// 网关、hook、记忆工具三个进程都会 import 的小东西：只放纯数据和纯函数——不读配置、不建目录、不起服务。
// 能放这里的，必须是“哪边 import 都安全”的（同 xk-board.mjs 开头那条注释）；重量级的东西别往这儿搬。
import fs from "node:fs";
import path from "node:path";

/** 界面上的叫法。角色名（ROLES[].name，比如 DeepSeek）是给上游看的，这张表是人看的；
 *  前端 xk.js 的 ROLE.name 要跟这张表对上（前端 import 不了网关模块） */
export const DISPLAY = { xiaoke: "小克", hachimi: "哈基米", deepseek: "小鱼", owner: "主人" };
export const displayName = (id) => DISPLAY[id] || id;

/** 渠道的中文名（日记素材、记忆摘要用）；前端 xk.js 的 CH 要跟这张表对上 */
export const CHANNEL = { app: "App", "qq-private": "QQ 私聊", "qq-group": "QQ 群" };
export const channelName = (c) => CHANNEL[c] || c;

/** 先写 .tmp 再改名：进程被杀、写到一半断电时不会留下半个文件。data 是字符串或 Buffer */
export function writeFileAtomic(file, data, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", data, mode ? { mode } : undefined);
  fs.renameSync(file + ".tmp", file);
}

/** 同上，内容是 JSON。indent 照原来各处的写法传（不传就是一行） */
export function writeJson(file, value, { indent, mode } = {}) {
  writeFileAtomic(file, JSON.stringify(value, null, indent), { mode });
}
