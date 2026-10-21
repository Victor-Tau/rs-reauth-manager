//! 通过 CPR 原生 OAuth 导入账号，登录秘密仅保留在私有进程内存
use crate::{
    Job, Manager, Queue,
    host::{admin, fault, now, query},
    worker::Worker,
};
use gateway_plugin_sdk::{PluginFault, client::HostClient};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

async fn catalog(host: &HostClient, path: &str) -> Result<Vec<Value>, PluginFault> {
    let mut result = vec![];
    for page in 1..=100 {
        let data = admin(
            host,
            "GET",
            &format!("{path}?page={page}&pageSize=200"),
            None,
        )
        .await?;
        let items = data["items"]
            .as_array()
            .ok_or_else(|| fault("选项列表格式无效"))?;
        result.extend(items.iter().cloned());
        let total = data["page"]["totalPages"]
            .as_u64()
            .ok_or_else(|| fault("选项分页格式无效"))?;
        if total > 100 || data["page"]["page"] != page {
            return Err(fault("选项分页超出范围"));
        }
        if page >= total {
            return Ok(result);
        }
    }
    Err(fault("选项列表超过上限"))
}
pub async fn options(host: &HostClient) -> Result<Value, PluginFault> {
    let groups = catalog(host, "/api/admin/account-groups/options")
        .await?
        .iter()
        .map(|g| json!({"id":g["id"],"name":g["name"]}))
        .collect::<Vec<_>>();
    let proxies = catalog(host, "/api/admin/proxies").await?.iter().map(|p| json!({"id":p["id"],"name":p["name"],"endpoint":p["endpoint"],"enabled":p["enabled"],"hasAuthentication":p["hasAuthentication"]})).collect::<Vec<_>>();
    Ok(json!({"groups":groups,"proxies":proxies}))
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelAccess {
    mode: String,
    models: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    notes: String,
    enabled: bool,
    concurrency_limit: Option<u64>,
    weight: u64,
    model_access: ModelAccess,
    group_ids: Vec<String>,
}
impl Settings {
    fn validate(&self) -> Result<(), PluginFault> {
        let m = &self.model_access;
        if self.notes.chars().count() > 500
            || self
                .notes
                .chars()
                .any(|c| c.is_control() && !['\r', '\n', '\t'].contains(&c))
            || !(1..=100).contains(&self.weight)
            || self
                .concurrency_limit
                .is_some_and(|v| v == 0 || v > u32::MAX as u64)
            || self.group_ids.len() > 100
            || self.group_ids.iter().any(|s| s.is_empty() || s.len() > 128)
            || !["all", "allowlist", "denylist"].contains(&m.mode.as_str())
            || (m.mode == "all") != m.models.is_empty()
            || m.models.len() > 256
            || m.models.iter().any(|s| {
                s.is_empty()
                    || s.trim() != s
                    || s.len() > 256
                    || s.starts_with("__")
                    || s.contains('*')
                    || s.chars().any(char::is_control)
            })
        {
            return Err(fault(
                "导入设置无效：请检查备注、权重、并发、分组及模型权限",
            ));
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Import {
    request_id: String,
    email: String,
    password: String,
    totp_secret: String,
    name: String,
    workspace_id: String,
    transport: String,
    outbound_proxy_id: String,
    login_proxy_url: String,
    save_login_notes: bool,
    settings: Settings,
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn validate(request: &mut Import) -> Result<String, PluginFault> {
    request.email = request.email.trim().to_owned();
    request.totp_secret = request.totp_secret.trim().to_uppercase().replace(' ', "");
    if uuid::Uuid::parse_str(&request.request_id).is_err()
        || !request.email.contains('@')
        || request.email.len() > 254
        || request.name.trim().is_empty()
        || request.name.len() > 256
        || request.name.chars().any(char::is_control)
        || request.password.is_empty()
        || request.totp_secret.is_empty()
        || !request
            .totp_secret
            .bytes()
            .all(|c| c.is_ascii_uppercase() || (b'2'..=b'7').contains(&c) || c == b'=')
        || [&request.email, &request.password, &request.totp_secret]
            .iter()
            .any(|s| s.contains("----") || s.chars().any(char::is_control))
        || (!request.workspace_id.is_empty() && !valid_id(&request.workspace_id))
        || !["http", "prefer_websocket"].contains(&request.transport.as_str())
    {
        return Err(fault(
            "账号导入参数无效，请检查邮箱、密码、Base32 2FA 密钥和传输方式",
        ));
    }
    let notes = format!(
        "{}----{}----{}",
        request.email, request.password, request.totp_secret
    );
    if notes.len() > 2000 {
        return Err(fault("登录资料过长"));
    }
    if request.save_login_notes {
        request.settings.notes = notes.clone()
    }
    request.settings.validate()?;
    request.settings.model_access.models.sort();
    request.settings.model_access.models.dedup();
    request.settings.group_ids.sort();
    request.settings.group_ids.dedup();
    Ok(notes)
}
async fn resolve_proxy(
    host: &HostClient,
    request: &Import,
) -> Result<(String, Value), PluginFault> {
    if request.outbound_proxy_id.is_empty() {
        if !request.login_proxy_url.is_empty() {
            return Err(fault("直连模式不能指定登录代理"));
        }
        return Ok((String::new(), Value::Null));
    }
    let proxies = catalog(host, "/api/admin/proxies").await?;
    let p = proxies
        .iter()
        .find(|p| p["id"] == request.outbound_proxy_id && p["enabled"] == true)
        .ok_or_else(|| fault("所选代理不存在或已禁用"))?;
    let mut address = p["endpoint"]
        .as_str()
        .ok_or_else(|| fault("代理地址无效"))?
        .to_owned();
    if !request.login_proxy_url.is_empty() {
        address = request.login_proxy_url.clone()
    } else if p["hasAuthentication"] == true {
        let data = admin(
            host,
            "GET",
            &query(
                "/api/admin/proxies/accounts",
                &[
                    ("proxyId", &request.outbound_proxy_id),
                    ("page", "1"),
                    ("pageSize", "200"),
                ],
            ),
            None,
        )
        .await?;
        let id = data["items"]
            .as_array()
            .and_then(|v| v.first())
            .and_then(|v| v["id"].as_str())
            .ok_or_else(|| fault("此认证代理尚无关联账号，请填写完整登录代理地址"))?;
        let export = admin(
            host,
            "GET",
            &query(
                "/api/admin/accounts/export",
                &[("accountIds", id), ("confirm", "export_sensitive_accounts")],
            ),
            None,
        )
        .await?;
        address = export["documents"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|doc| doc["document"]["accounts"].as_array().into_iter().flatten())
            .find(|a| a["id"] == id)
            .and_then(|a| a["outboundProxyUrl"].as_str())
            .ok_or_else(|| fault("代理认证无法读取，请填写完整登录代理地址"))?
            .to_owned();
    }
    let mut parsed = url::Url::parse(&address).map_err(|_| fault("登录代理地址无效"))?;
    if !["http", "https", "socks5", "socks5h"].contains(&parsed.scheme())
        || parsed.host_str().is_none()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(fault("登录代理协议无效"));
    }
    parsed.set_username("").map_err(|_| fault("登录代理无效"))?;
    parsed
        .set_password(None)
        .map_err(|_| fault("登录代理无效"))?;
    let endpoint = url::Url::parse(p["endpoint"].as_str().unwrap_or_default())
        .map_err(|_| fault("代理地址无效"))?;
    if parsed != endpoint {
        return Err(fault("登录代理与所选 CPR 代理地址不一致"));
    }
    Ok((
        address,
        json!({"id":p["id"],"revision":p["revision"],"endpoint":p["endpoint"]}),
    ))
}
pub async fn submit(
    manager: &mut Manager,
    host: &HostClient,
    payload: &[u8],
    mut queue: Queue,
    version: Option<u64>,
) -> Result<Value, PluginFault> {
    if !queue.enabled {
        return Err(fault("插件已关闭，请先打开插件开关"));
    }
    let mut request: Import =
        serde_json::from_slice(payload).map_err(|_| fault("导入请求格式无效"))?;
    let notes = validate(&mut request)?;
    let id = format!("{}:import", request.request_id);
    if queue.jobs.iter().any(|j| j.request_id == id) {
        return Ok(json!({"jobs":queue.jobs}));
    }
    if manager.worker.is_some() || queue.jobs.iter().any(Job::active) {
        return Err(fault("请等待当前授权队列结束后导入账号"));
    }
    let accounts = crate::rows(host).await?;
    if accounts["accounts"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|a| {
            a["email"]
                .as_str()
                .is_some_and(|v| v.eq_ignore_ascii_case(&request.email))
        })
    {
        return Err(fault(
            "该邮箱已有 OAuth 账号，请使用重新授权，避免覆盖现有账号",
        ));
    }
    let available = options(host).await?;
    if request.settings.group_ids.iter().any(|id| {
        !available["groups"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|g| g["id"] == *id)
    }) {
        return Err(fault("导入分组已不存在，请刷新选项"));
    }
    let (proxy, proxy_snapshot) = resolve_proxy(host, &request).await?;
    manager.runtime.prepare().await?;
    let mut job = Job::queued(id.clone(), String::new(), false);
    job.kind = "import".into();
    job.status = "running".into();
    job.step = "preparing".into();
    job.started_at = Some(now());
    job.log("导入参数、分组与代理已核对，创建 CPR 原生授权流程");
    queue.jobs.push(job);
    crate::trim_jobs(&mut queue);
    crate::host::save(host, &queue, version).await?;
    let result = async {
        let start = admin(host, "POST", "/api/admin/accounts/oauth/start", Some(json!({"provider":"openai","name":request.name,"outboundProxyId":request.outbound_proxy_id}))).await?;
        let flow = start["flowId"].as_str().ok_or_else(|| fault("CPR 授权流程无效"))?.to_owned();
        let input = json!({"mode":"import","notes":notes,"email":request.email,"proxy":proxy,"authorizationUrl":start["authorizationUrl"],"accountId":request.workspace_id});
        let snapshot = json!({"email":request.email,"settings":request.settings,"transport":request.transport,"proxy":proxy_snapshot});
        manager.runtime.start(input, flow, snapshot, id.clone()).await
    }.await;
    if let Ok(worker) = result {
        manager.worker = Some(worker)
    } else {
        let error = result.err().ok_or_else(|| fault("导入初始化失败"))?;
        let (mut latest, revision) = crate::host::load(host).await?;
        if let Some(job) = latest.jobs.iter_mut().find(|j| j.request_id == id) {
            job.finish("failed", &error.message)
        }
        crate::host::save(host, &latest, revision).await?;
    }
    Ok(json!({"jobs":crate::host::load(host).await?.0.jobs}))
}
pub async fn finish(host: &HostClient, job: &mut Job, current: &Worker, output: &Value) {
    if output["event"] != "complete" {
        if output["code"] == "workspace" {
            job.finish("failed", "工作区无法唯一确定，请指定工作区 ID 后重新导入");
            job.step = "workspace".into();
            job.workspace_choices = crate::workspace_choices(output);
            return;
        }
        job.finish(
            "failed",
            &crate::diagnostics::message(
                output,
                crate::protocol_error(output["code"].as_str().unwrap_or_default()),
            ),
        );
        return;
    }
    job.log("收到授权回调，交由 CPR 交换令牌并创建账号");
    let result = async {
        let selected = &current.snapshot["proxy"];
        if !selected.is_null() {
            let proxies = catalog(host, "/api/admin/proxies").await?;
            if !proxies.iter().any(|p| p["id"] == selected["id"] && p["revision"] == selected["revision"] && p["enabled"] == true && p["endpoint"] == selected["endpoint"]) { return Err(fault("登录期间代理配置发生变化，已停止导入")) }
        }
        // 先停用建号，核对身份与参数后再按要求启用
        let mut settings = current.snapshot["settings"].clone(); settings["enabled"] = json!(false);
        let done = admin(host, "POST", "/api/admin/accounts/oauth/complete", Some(json!({"provider":"openai","flowId":current.flow,"callbackUrl":output["callbackUrl"],"settings":settings}))).await?;
        let id = done["accountId"].as_str().filter(|id| valid_id(id)).ok_or_else(|| fault("导入结果未知，请在 CPR 中核对账号，勿重复提交"))?;
        job.account_id = id.into();
        let detail = admin(host, "GET", &query("/api/admin/accounts/detail", &[("accountId",id)]), None).await?;
        let a = &detail["account"];
        let expected_email = current.snapshot["email"].as_str().unwrap_or_default();
        if !a["email"].as_str().is_some_and(|v| v.eq_ignore_ascii_case(expected_email)) || a["provider"] != "openai" || a["authenticationKind"] != "oauth" || a["enabled"] != false || a["hasRefreshToken"] != true {
            return Err(fault("账号已创建，但身份或停用状态核对失败，请在 CPR 中核对"))
        }
        // 后续修改前持久化已创建的账号 ID
        let (mut queue, version) = crate::host::load(host).await?;
        if let Some(stored) = queue.jobs.iter_mut().find(|j| j.request_id == job.request_id) { stored.account_id = id.into() }
        crate::host::save(host, &queue, version).await?;
        let mut update = settings.clone();
        update["accountId"] = json!(id); update["connection"] = json!({"transport":current.snapshot["transport"]});
        admin(host, "POST", "/api/admin/accounts/update", Some(update.clone())).await?;
        verify(host, id, &settings, &current.snapshot).await?;
        if current.snapshot["settings"]["enabled"] == true {
            update["enabled"] = json!(true);
            admin(host, "POST", "/api/admin/accounts/update", Some(update)).await?;
            settings["enabled"] = json!(true);
            verify(host, id, &settings, &current.snapshot).await?;
        }
        Ok::<(), PluginFault>(())
    }.await;
    match result {
        Ok(()) => job.finish("success", "账号已导入 CPR，参数校验通过"),
        Err(_) => job.finish(
            "review",
            "导入结果需要核对，请检查 CPR 账号及参数，勿重复提交",
        ),
    }
}
async fn verify(
    host: &HostClient,
    id: &str,
    settings: &Value,
    snapshot: &Value,
) -> Result<(), PluginFault> {
    let data = admin(
        host,
        "GET",
        &query("/api/admin/accounts/detail", &[("accountId", id)]),
        None,
    )
    .await?;
    let a = &data["account"];
    let group_ids: std::collections::BTreeSet<_> = a["groups"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| g["id"].as_str())
        .collect();
    let expected: std::collections::BTreeSet<_> = settings["groupIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if a["id"] != id
        || a["enabled"] != settings["enabled"]
        || a["notes"].as_str().unwrap_or_default() != settings["notes"].as_str().unwrap_or_default()
        || a["weight"] != settings["weight"]
        || a["concurrencyLimit"] != settings["concurrencyLimit"]
        || a["modelAccess"] != settings["modelAccess"]
        || group_ids != expected
        || data["credentialConfiguration"]["transport"] != snapshot["transport"]
    {
        return Err(fault("导入参数核对失败"));
    }
    if snapshot["proxy"].is_null() {
        if !a["outboundProxyEndpoint"].is_null() {
            return Err(fault("导入直连配置核对失败"));
        }
    } else {
        let binding = crate::proxies::binding(host, a).await?;
        if binding["id"] != snapshot["proxy"]["id"] {
            return Err(fault("导入代理绑定核对失败"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn import_settings_follow_official_ranges() {
        let mut s = Settings {
            notes: String::new(),
            enabled: false,
            concurrency_limit: None,
            weight: 100,
            model_access: ModelAccess {
                mode: "all".into(),
                models: vec![],
            },
            group_ids: vec![],
        };
        assert!(s.validate().is_ok());
        s.weight = 101;
        assert!(s.validate().is_err());
        s.weight = 1;
        s.concurrency_limit = Some(0);
        assert!(s.validate().is_err());
        s.concurrency_limit = Some(u32::MAX.into());
        assert!(s.validate().is_ok());
        s.model_access.mode = "allowlist".into();
        assert!(s.validate().is_err());
        s.model_access.models.push("gpt-5".into());
        assert!(s.validate().is_ok());
        s.model_access.models.push("gpt-*".into());
        assert!(s.validate().is_err());
    }
}
