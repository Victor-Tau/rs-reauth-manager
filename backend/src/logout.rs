//! 使用原账号授权和代理退出全部登录，停用调度并阻止自动重登
use crate::{
    Job, detail,
    host::{admin, fault},
    proxy, require_idle, settings,
    worker::{Runtime, Worker},
};
use gateway_plugin_sdk::{PluginFault, call::host::AuthCredential, client::HostClient};
use serde_json::{Value, json};

pub async fn start(
    runtime: &mut Runtime,
    host: &HostClient,
    job: &Job,
) -> Result<Worker, PluginFault> {
    runtime.prepare().await?;
    let id = &job.account_id;
    let original = detail(host, id).await?;
    require_idle(&original)?;
    let proxy = proxy(host, &original).await?;
    let reply = host
        .call(
            "host.auth.get",
            json!({}),
            serde_json::to_vec(&json!({"account_id":id})).map_err(|_| fault("账号参数无效"))?,
        )
        .await
        .map_err(|_| fault("读取退出登录凭据失败"))?;
    let credential: AuthCredential =
        serde_json::from_slice(&reply.payload).map_err(|_| fault("退出登录凭据格式无效"))?;
    let facts = credential.facts;
    if credential.account_id != *id
        || credential.provider_id != "openai"
        || Some(credential.credential_revision) != original["_credentialRevision"].as_u64()
        || facts.authentication_kind != "oauth"
        || facts.email.as_deref() != original["email"].as_str()
        || facts.upstream_account_id.as_deref() != original["accountId"].as_str()
        || facts.upstream_user_id.as_deref() != original["userId"].as_str()
    {
        return Err(fault("退出登录凭据与原账号不匹配，未发送退出请求"));
    }
    let token = facts
        .material
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 16384
                && !s.chars().any(|c| c.is_control() || c.is_whitespace())
        })
        .ok_or_else(|| fault("账号没有可用访问令牌，请先重新授权"))?;
    let upstream = facts
        .upstream_account_id
        .as_deref()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        })
        .ok_or_else(|| fault("无法确认原账号上游身份，未发送退出请求"))?;
    let cookies: Vec<_> = facts
        .material
        .get("cookies")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|c| {
            matches!(c["domain"].as_str(), Some("chatgpt.com" | ".chatgpt.com"))
                && c["path"].as_str().is_some_and(|p| {
                    p == "/"
                        || p == "/backend-api"
                        || p == "/backend-api/"
                        || p == "/backend-api/accounts"
                        || p == "/backend-api/accounts/"
                        || p == "/backend-api/accounts/logout_all"
                })
        })
        .map(|c| json!({"name":c["name"],"value":c["value"]}))
        .collect();
    let input = json!({"mode":"logout","email":original["email"],"proxy":proxy,"accessToken":token,"accountId":upstream,"cookies":cookies});
    if serde_json::to_vec(&input)
        .map_err(|_| fault("退出登录参数无效"))?
        .len()
        > 65536
    {
        return Err(fault("退出登录凭据过长，未发送退出请求"));
    }
    let latest = detail(host, id).await?;
    require_idle(&latest)?;
    if settings(&latest) != settings(&original)
        || latest["_credentialRevision"] != original["_credentialRevision"]
    {
        return Err(fault("账号配置或凭据已变化，未发送退出请求"));
    }
    // 先停用并读回，避免退出后继续调度已失效的授权
    if original["enabled"] != false {
        admin(
            host,
            "POST",
            "/api/admin/accounts/batch-update",
            Some(json!({"accountIds":[id],"enabled":false})),
        )
        .await
        .map_err(|_| fault("停止调度结果待核对，未发送退出请求"))?;
    }
    let result = async {
        let disabled = detail(host, id).await?;
        require_idle(&disabled)?;
        let mut expected = settings(&original);
        expected["enabled"] = json!(false);
        if settings(&disabled) != expected
            || disabled["_credentialRevision"] != original["_credentialRevision"]
        {
            return Err(fault("停止调度后的账号配置未确认"));
        }
        runtime
            .start(
                input,
                String::new(),
                json!({"settings":expected,"credentialRevision":original["_credentialRevision"]}),
                job.request_id.clone(),
            )
            .await
    }
    .await;
    result.map_err(|_| fault("已执行停止调度，但退出请求未能启动，请核对账号；不会自动重登"))
}

pub async fn finish(host: &HostClient, job: &mut Job, current: &Worker, output: &Value) {
    if output["event"] == "logout_complete" {
        let after = detail(host, &job.account_id).await;
        if !after.is_ok_and(|a| {
            a["enabled"] == false
                && settings(&a) == current.snapshot["settings"]
                && a["_credentialRevision"] == current.snapshot["credentialRevision"]
        }) {
            job.finish("review", "上游已确认退出所有登录，但账号配置发生变化或停止调度状态未确认；请人工核对，不会自动重登");
            return;
        }
        job.finish(
            "success",
            "上游已确认退出所有登录，已停止调度；需要时请手动重新授权",
        );
        job.step = "logged_out".into();
        return;
    }
    let status = output["httpStatus"]
        .as_u64()
        .filter(|v| (100..=599).contains(v));
    let message = match (output["code"].as_str(), status) {
        (Some("logout_rejected"), Some(401 | 403)) => {
            "上游拒绝退出请求，当前授权无效或无权限；已停止调度，请手动重新授权后重试"
        }
        (Some("logout_rejected"), Some(429)) => "上游限制退出请求频率；已停止调度，不会自动重试",
        (Some("logout_credentials"), _) => "退出凭据或代理格式无效，未发送退出请求；已停止调度",
        _ => "退出请求结果未确认；已停止调度，请核对所有设备登录状态，不会自动重试或重登",
    };
    job.finish(
        if output["code"] == "logout_rejected" || output["code"] == "logout_credentials" {
            "failed"
        } else {
            "review"
        },
        message,
    );
    if let Some(status) = status {
        job.message.push_str(&format!("（HTTP {status}）"));
    }
}
