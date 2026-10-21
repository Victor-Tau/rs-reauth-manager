//! 将协议诊断白名单投影为可公开的中文错误，不透传上游正文
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub at: u64,
    pub message: String,
}

pub fn lifecycle(message: &str) -> LogEntry {
    LogEntry {
        at: crate::host::now(),
        message: message.into(),
    }
}

pub fn trace(entry: &Value) -> Option<LogEntry> {
    let action = match entry["action"].as_str()? {
        "request" => "发起请求",
        "response" => "收到响应",
        "transport" => "传输失败",
        "workspace_candidates" => "提取工作区候选",
        "callback_result" => "提取并校验授权回调",
        _ => return None,
    };
    let stage = message(
        &serde_json::json!({"diagnostic":{"stage":entry["stage"]}}),
        "登录协议",
    );
    let mut parts = vec![format!(
        "{} · {action}",
        stage.split('：').next().unwrap_or("登录协议")
    )];
    if let Some(method @ ("GET" | "POST")) = entry["method"].as_str() {
        parts.push(method.into());
    }
    for (key, label, limit) in [
        ("httpStatus", "HTTP", 599),
        ("elapsedMs", "耗时 ms", 600000),
        ("responseBytes", "响应字节", 16000000),
        ("count", "候选数", 10000),
    ] {
        if let Some(value) = entry[key].as_u64().filter(|v| *v <= limit) {
            parts.push(format!("{label} {value}"));
        }
    }
    for (key, label) in [
        ("found", "找到"),
        ("redirect", "重定向"),
        ("callbackFound", "回调"),
        ("continueFound", "继续地址"),
        ("stateMatched", "state 匹配"),
    ] {
        if let Some(value) = entry[key].as_bool() {
            parts.push(format!("{label} {}", if value { "是" } else { "否" }));
        }
    }
    if let Some(
        page @ ("log-in" | "mfa-challenge" | "workspace" | "organization" | "consent" | "http-page"
        | "email-verification" | "add-phone" | "choose-an-account" | "edge-challenge"),
    ) = entry["pageType"].as_str()
    {
        parts.push(format!("页面 {page}"));
    }
    if let Some(kind @ ("text/html" | "application/json" | "text/plain")) =
        entry["contentType"].as_str()
    {
        parts.push(format!("类型 {kind}"));
    }
    if let Some(source @ ("session" | "page")) = entry["source"].as_str() {
        parts.push(format!("来源 {source}"));
    }
    if let Some(
        reason @ ("request_timeout" | "dns_failed" | "tls_failed" | "connection_failed"
        | "transport_failed"),
    ) = entry["reason"].as_str()
    {
        parts.push(reason.into());
    }
    Some(lifecycle(&parts.join(" · ")))
}

pub fn message(output: &Value, fallback: &str) -> String {
    let Some(diagnostic) = output.get("diagnostic").filter(|d| d.is_object()) else {
        return fallback.into();
    };
    let stage = match diagnostic["stage"].as_str().unwrap_or_default() {
        "authorize" => "获取授权页面",
        "login" => "提交登录身份",
        "password" => "密码验证",
        "mfa_factor" => "识别 2FA 验证器",
        "mfa_issue" => "创建 2FA 验证挑战",
        "mfa_verify" => "提交 2FA 动态码",
        "email_send" => "发送邮箱验证码",
        "email_verify" => "邮箱验证码验证",
        "phone" => "手机验证",
        "workspace" => "选择工作区",
        "organization" => "选择组织",
        "consent" => "授权确认",
        "callback" => "校验授权回调",
        "token_exchange" => "交换授权令牌",
        "identity" => "校验授权身份",
        "logout" => "退出所有登录",
        _ => "登录协议",
    };
    let reason = match diagnostic["reason"].as_str().unwrap_or_default() {
        "password_rejected" => "上游拒绝邮箱或密码",
        "mfa_secret_missing" => "未提供 2FA 密钥",
        "mfa_factor_missing" => "未找到可用的 TOTP 验证器，不能据此判断密钥错误",
        "mfa_provider_invalid" => "2FA 动态码生成器不可用",
        "mfa_code_unavailable" => "未能取得有效的六位 2FA 动态码",
        "mfa_issue_failed" => "上游未成功创建 2FA 验证挑战，并非已确认验证码错误",
        "mfa_code_rejected" => "上游拒绝 2FA 动态码，可能已失效、被使用或与验证器不匹配",
        "mfa_verification_failed" => "2FA 验证流程未完成，未取得明确的验证码拒绝原因",
        "primary_factor_required" => "上游要求先完成密码或邮箱验证，不能只使用 2FA",
        "email_code_required" => "上游要求邮箱验证码，当前任务不支持人工补码续跑",
        "email_code_rejected" => "上游拒绝邮箱验证码",
        "email_verification_failed" => "邮箱验证流程未完成",
        "phone_required" => "上游要求手机验证，需要人工完成",
        "profile_required" => "上游要求补充账号资料",
        "security_challenge" => "上游要求浏览器安全验证，需要人工完成",
        "rate_limited" => "上游限制登录频率，不自动重试",
        "request_timeout" => "请求超时，保留原代理，不自动重试",
        "dns_failed" => "域名或代理地址解析失败",
        "tls_failed" => "TLS 连接或证书校验失败",
        "connection_failed" => "连接中断或代理连接失败",
        "transport_failed" => "请求传输异常，未保存原始异常内容",
        "upstream_unavailable" => "上游服务暂不可用",
        "http_rejected" => "上游拒绝请求，未取得可公开的具体原因",
        "account_selection_failed" => "上游账号选择未完成",
        "callback_missing" => "未取得有效授权回调",
        "callback_hops_exhausted" => "授权跳转达到上限，未取得回调",
        "login_continue_failed" => "上游登录步骤未返回可继续的授权地址",
        "token_exchange_failed" => "授权码换取令牌未成功，未写回",
        "state_mismatch" => "授权回调 state 校验未通过，未写回",
        "workspace_unmatched" => "无法匹配原账号工作区，已停止写回",
        "identity_unconfirmed" => "新授权的同一用户或 Free 工作区校验未通过，未写回",
        _ => "未取得可公开的具体错误，未保存上游原始响应",
    };
    let mut message = format!("{stage}：{reason}");
    if let Some(status) = diagnostic["httpStatus"]
        .as_u64()
        .filter(|v| (100..=599).contains(v))
    {
        message.push_str(&format!("（最后响应 HTTP {status}）"));
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renders_only_known_diagnostic_fields() {
        let rendered = message(
            &json!({"diagnostic":{"stage":"mfa_issue","reason":"mfa_issue_failed","httpStatus":403,"raw":"private-body"}}),
            "fallback",
        );
        assert!(rendered.contains("创建 2FA 验证挑战"));
        assert!(rendered.contains("HTTP 403"));
        assert!(!rendered.contains("private-body"));
        assert_eq!(message(&json!({}), "legacy"), "legacy");
    }

    #[test]
    fn untrusted_details_cannot_reach_job_history() {
        let rendered = message(
            &json!({"diagnostic":{"stage":"private-url","reason":"private-secret","httpStatus":"private-header"}}),
            "fallback",
        );
        assert!(!rendered.contains("private-"));
        assert!(!rendered.contains("HTTP"));
        assert!(
            !message(&json!({"diagnostic":{"httpStatus":999999}}), "fallback").contains("HTTP")
        );
    }

    #[test]
    fn detailed_logs_project_only_public_features() {
        let entry = trace(&json!({"action":"response","stage":"consent","method":"POST","httpStatus":200,"elapsedMs":123,"pageType":"consent","contentType":"text/html","redirect":false,"responseBytes":420,"raw":"private-secret","url":"private-callback","cookie":"private-cookie"})).unwrap();
        assert!(entry.message.contains("授权确认"));
        assert!(entry.message.contains("HTTP 200"));
        assert!(entry.message.contains("耗时 ms 123"));
        assert!(!entry.message.contains("private-"));
        let entry = trace(&json!({"action":"response","stage":"private-secret","method":"private-secret","httpStatus":90000,"pageType":"private-secret","contentType":"private-secret","count":-1})).unwrap();
        assert!(!entry.message.contains("private-"));
        assert!(!entry.message.contains("90000"));
        assert!(trace(&json!({"action":"private-secret"})).is_none());
    }
}
