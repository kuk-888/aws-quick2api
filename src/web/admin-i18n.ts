import type http from "node:http";
import { GatewayError } from "../core/types.js";

export type AdminLang = "zh" | "en";

export function resolveAdminLang(req: http.IncomingMessage): AdminLang {
  const explicit = req.headers["x-console-lang"];
  const rawExplicit = (Array.isArray(explicit) ? explicit[0] : explicit)?.trim().toLowerCase();
  if (rawExplicit === "zh" || rawExplicit === "zh-cn" || rawExplicit === "zh-tw") return "zh";
  if (rawExplicit === "en" || rawExplicit === "en-us" || rawExplicit === "en-gb") return "en";

  const accept = req.headers["accept-language"];
  const rawAccept = (Array.isArray(accept) ? accept[0] : accept)?.trim().toLowerCase() ?? "";
  if (rawAccept.startsWith("zh")) return "zh";
  return "en";
}

const EXACT_ZH: Record<string, string> = {
  "Missing CSRF header.": "缺少 CSRF 安全请求头（X-Console-CSRF）。",
  "Admin console is disabled: set ADMIN_PASSWORD in .env and restart.": "管理后台已禁用：请在 .env 中设置 ADMIN_PASSWORD 并重启服务。",
  "Unauthorized: administrator credentials required.": "未授权：请先登录管理员后台。",
  "Admin authentication required.": "未授权：请先登录管理员后台。",
  "Invalid admin password.": "管理员密码错误。",
  "Too many failed attempts. Try again later.": "连续失败次数过多，来源 IP 已被临时锁定，请稍后再试。",
  "JSON object expected.": "请求体必须是 JSON 对象。",
  "Request body must be a JSON object.": "请求体必须是 JSON 对象。",
  "Log entry not found.": "未找到对应的请求日志记录。",
  "Key slot not found.": "未找到对应的 AWS Quick 凭证槽位。",
  "Client gateway key not found.": "未找到对应的网关子密钥。",
  "`action` string required.": "缺少必填字符串参数 `action`。",
  "Unsupported batch action.": "不支持的批量操作类型。",
  "`prompt` string required.": "缺少必填字符串参数 `prompt`。",
  "`apiKey` string required.": "缺少必填字符串参数 `apiKey`。",
  "`sessionToken` string required.": "缺少必填字符串参数 `sessionToken`。",
  "Creating an API key requires `confirm: true`.": "创建新 API Key 需要显式传入 `confirm: true` 确认。",
  "`mode` must be \"on\" or \"off\".": "`mode` 参数必须为 \"on\" 或 \"off\"。",
  "On-demand update failed.": "更新 On-Demand 按需开关失败。",
  "New admin password must be at least 8 characters.": "新管理员密码长度至少为 8 位。",
  "New admin password cannot contain newline characters.": "新管理员密码不能包含换行符。",
  "Admin password must not contain newline characters.": "管理员密码不能包含换行符。",
  "Custom token must be at least 6 characters.": "自定义子密钥长度至少为 6 位。",
  "Custom token contains invalid characters or whitespace.": "自定义子密钥包含非法字符或空白符。",
  "Duplicate client token already exists.": "该客户端子密钥已存在，请更换其他 Token。",
  "Cannot delete the last client gateway key.": "无法删除最后一把网关子密钥。",
  "Invalid AWS Quick credential (use `local-outpost` or an `id_token`).": "无效的 AWS Quick 凭证（请填入 local-outpost 或有效的 id_token）。",
  "This AWS Quick credential already exists in the pool.": "该 AWS Quick 凭证已存在于号池中。",
  "Malformed JSON request body.": "请求体 JSON 格式错误。",
  "Content-Type must be application/json.": "Content-Type 必须为 application/json。",
  "Failed to read request body.": "读取请求体失败。",
  "No enabled upstream AWS Quick credentials available.": "当前没有可用的上游 AWS Quick 凭证。",
  "All upstream AWS Quick accounts are currently disabled or unconfigured.": "所有上游 AWS Quick 账号均已停用或未配置。",
  "Please enter the admin password.": "请输入管理密码。",
  "New admin password must be 128 chars or fewer with no control characters.": "新管理密码不能包含控制字符，且长度不能超过 128 位。",
  "Invalid expiration timestamp; provide a valid date-time.": "过期时间格式无效，请提供合法的日期时间。",
  "Custom gateway token must be at least 6 characters.": "自定义网关密钥长度至少需 6 位。",
  "A gateway key with this token already exists.": "该网关密钥 Token 已存在，请勿重复创建。",
  "Select at least one allowed model under custom allowlist mode.": "指定模型白名单模式下，请至少勾选 1 个允许访问的模型。",
  "`name` string required.": "缺少必填字符串参数 `name`。",
  "Account group name is required.": "请输入账号分组名称。",
  "Both current and new group names are required.": "请同时提供当前分组名称与新分组名称。",
  "Invalid URL-encoded group name.": "分组名称 URL 编码无效。",
  "Invalid proxy URL.": "代理地址格式无效。",
  "Invalid `showRoutedModelInThinking` value (expected 'true', 'always', or 'false').": "`showRoutedModelInThinking` 参数无效（仅支持 'true'、'always' 或 'false'）。",
  "`group` must be a string or null.": "批量分组操作必须传入字符串或 null 类型的 `group` 参数。",
  "`group` string or null is required for `set-group` action.": "批量分组操作必须传入字符串或 null 类型的 `group` 参数。"
};

const EXACT_EN: Record<string, string> = {
  "请输入管理密码。": "Please enter the admin password.",
  "管理密码错误。": "Invalid admin password.",
  "新管理密码长度至少为 8 位。": "New admin password must be at least 8 characters.",
  "新管理密码不能包含控制字符，且长度不能超过 128 位。": "New admin password must be 128 chars or fewer with no control characters.",
  "过期时间格式无效，请提供合法的日期时间。": "Invalid expiration timestamp; provide a valid date-time.",
  "自定义网关密钥长度至少需 6 位。": "Custom gateway token must be at least 6 characters.",
  "该网关密钥 Token 已存在，请勿重复创建。": "A gateway key with this token already exists.",
  "指定模型白名单模式下，请至少勾选 1 个允许访问的模型。": "Select at least one allowed model under custom allowlist mode.",
  "重新检测仍被上游拒绝": "Recheck rejected by upstream (401/403).",
  "额度耗尽自动熔断 (Quota Exhausted)": "Auto-disabled: quota exhausted.",
  "鉴权失效自动关停 (401 Unauthorized)": "Auto-disabled: authentication failed (401 Unauthorized)."
};

export function localizeAdminMessage(msg: string, lang: AdminLang): string {
  if (lang === "en") {
    if (EXACT_EN[msg]) return EXACT_EN[msg];
    const zhLock = /^连续失败次数过多，该来源 IP 已被锁定，请 (\d+) 秒后重试。$/.exec(msg);
    if (zhLock) return `Too many failed attempts. Try again in ${zhLock[1]} seconds.`;
    if (msg.startsWith("额度耗尽自动熔断:")) {
      return `Auto-disabled (quota exhausted): ${msg.slice("额度耗尽自动熔断:".length).trim()}`;
    }
    if (msg.startsWith("鉴权失效自动关停:")) {
      return `Auto-disabled (auth failed): ${msg.slice("鉴权失效自动关停:".length).trim()}`;
    }
    return msg;
  }

  if (EXACT_ZH[msg]) return EXACT_ZH[msg];

  const tooLarge = /^Request body exceeds limit of (\d+) bytes\.$/.exec(msg);
  if (tooLarge) return `请求体大小超过限制（上限 ${tooLarge[1]} 字节）。`;

  const notAllowed = /^Method ([A-Z]+) not allowed for (.+)\.$/.exec(msg);
  if (notAllowed) return `端点 ${notAllowed[2]} 不支持 ${notAllowed[1]} 请求方法。`;

  const unsupported = /^Unsupported endpoint: ([A-Z]+) (.+)$/.exec(msg);
  if (unsupported) return `不支持的管理端点：${unsupported[1]} ${unsupported[2]}。`;

  const slotNotFound = /^Key slot '([^']+)' not found\.$/.exec(msg);
  if (slotNotFound) return `未找到凭证槽位 '${slotNotFound[1]}'。`;

  const gkNotFound = /^Gateway key '([^']+)' not found\.$/.exec(msg);
  if (gkNotFound) return `未找到网关子密钥 '${gkNotFound[1]}'。`;

  const grpNotFound = /^Account group '([^']+)' not found\.$/.exec(msg);
  if (grpNotFound) return `未找到账号分组 '${grpNotFound[1]}'。`;

  const grpExists = /^Account group '([^']+)' already exists\.$/.exec(msg);
  if (grpExists) return `账号分组 '${grpExists[1]}' 已存在。`;

  const grpNoKeys = /^No enabled upstream AWS Quick credentials available in group '([^']+)'\.$/.exec(msg);
  if (grpNoKeys) return `分组 '${grpNoKeys[1]}' 内当前没有可用的上游 AWS Quick 凭证。`;

  if (msg.startsWith("Invalid account group name")) {
    return "账号分组名称无效（最多 48 字符，不能包含逗号、斜杠、控制字符或保留名称 . / ..）。";
  }

  return msg;
}

export function localizeAdminError(err: GatewayError, lang: AdminLang): GatewayError {
  const localized = localizeAdminMessage(err.message, lang);
  if (localized === err.message) return err;
  const copy = new GatewayError(localized, err.status, err.code, err.param);
  const extra = err as GatewayError & { retryAfter?: number; allow?: string };
  if (extra.retryAfter !== undefined) (copy as GatewayError & { retryAfter?: number }).retryAfter = extra.retryAfter;
  if (extra.allow !== undefined) (copy as GatewayError & { allow?: string }).allow = extra.allow;
  return copy;
}
