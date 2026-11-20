//! 独立邮箱换绑会话、手动验证码与新登录资料私有保存
use crate::{
    Manager,
    host::{self, fault, now},
    worker::Worker,
};
use gateway_plugin_sdk::{
    PluginFault,
    call::host::{StateGetResult, StatePutResult},
    client::HostClient,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Begin {
    request_id: String,
    email: String,
    password: String,
    totp_secret: String,
    new_email: String,
    proxy_url: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    request_id: String,
    email: String,
    new_email: String,
    status: String,
    step: String,
    message: String,
    created_at: u64,
    credentials: Option<String>,
}
pub struct Pending {
    pub worker: Worker,
    credentials: String,
}
async fn load(host: &HostClient) -> Result<(Vec<Record>, Option<u64>), PluginFault> {
    let reply = host
        .call(
            "host.state.get",
            json!({"namespace":"reauth-manager","key":"email-changes"}),
            vec![],
        )
        .await
        .map_err(|e| e.into_plugin_fault())?;
    let data: StateGetResult =
        serde_json::from_value(reply.result).map_err(|_| fault("换绑记录读取失败"))?;
    match data.record {
        Some(record) => Ok((
            serde_json::from_value(record.value).map_err(|_| fault("换绑记录格式无效"))?,
            Some(record.version),
        )),
        None => Ok((vec![], None)),
    }
}
async fn save(
    host: &HostClient,
    records: &[Record],
    version: Option<u64>,
) -> Result<(), PluginFault> {
    let value = serde_json::to_value(records).map_err(|_| fault("换绑记录编码失败"))?;
    if serde_json::to_vec(&value).map_or(usize::MAX, |b| b.len()) > 240 * 1024 {
        return Err(fault("换绑记录容量已满，请先复制并清理旧记录"));
    }
    let reply = host.call("host.state.put", json!({"namespace":"reauth-manager","key":"email-changes","value":value,"expected_version":version}), vec![]).await.map_err(|e| e.into_plugin_fault())?;
    let _: StatePutResult =
        serde_json::from_value(reply.result).map_err(|_| fault("换绑资料保存失败"))?;
    Ok(())
}
fn active(record: &Record) -> bool {
    matches!(record.status.as_str(), "running" | "verifying")
}
pub async fn recover(host: &HostClient) -> Result<(), PluginFault> {
    let (mut records, version) = load(host).await?;
    let mut changed = false;
    for record in records.iter_mut().filter(|r| active(r)) {
        record.status = if record.credentials.is_some() {
            "review"
        } else {
            "interrupted"
        }
        .into();
        record.message = "插件已重启，会话已结束，请先核对新旧邮箱，不会自动重试".into();
        changed = true;
    }
    if changed {
        save(host, &records, version).await?;
    }
    Ok(())
}
pub async fn list(host: &HostClient) -> Result<Value, PluginFault> {
    let (records, _) = load(host).await?;
    Ok(
        json!({"records": records.iter().rev().map(|r| json!({"requestId":r.request_id,"email":r.email,"newEmail":r.new_email,"status":r.status,"step":r.step,"message":r.message,"createdAt":r.created_at,"hasCredentials":r.credentials.is_some()})).collect::<Vec<_>>()}),
    )
}
fn valid_email(value: &str) -> bool {
    value.len() <= 254
        && value.split('@').count() == 2
        && value.split('@').all(|p| !p.is_empty())
        && !value.contains("----")
        && !value.chars().any(|c| c.is_whitespace() || c.is_control())
}
pub async fn begin(
    manager: &mut Manager,
    host: &HostClient,
    payload: &[u8],
) -> Result<Value, PluginFault> {
    let mut request: Begin =
        serde_json::from_slice(payload).map_err(|_| fault("换绑参数格式无效"))?;
    request.email = request.email.trim().into();
    request.new_email = request.new_email.trim().into();
    request.totp_secret = request.totp_secret.trim().to_uppercase().replace(' ', "");
    if uuid::Uuid::parse_str(&request.request_id).is_err()
        || !valid_email(&request.email)
        || !valid_email(&request.new_email)
        || request.email.eq_ignore_ascii_case(&request.new_email)
        || request.password.is_empty()
        || request.password.contains("----")
        || request.password.chars().any(char::is_control)
        || request.totp_secret.is_empty()
        || !request
            .totp_secret
            .bytes()
            .all(|c| c.is_ascii_uppercase() || (b'2'..=b'7').contains(&c) || c == b'=')
    {
        return Err(fault(
            "请检查新旧邮箱、密码和 Base32 2FA 密钥，新旧邮箱不能相同",
        ));
    }
    let credentials = format!(
        "{}----{}----{}",
        request.new_email, request.password, request.totp_secret
    );
    if credentials.len() > 2000 {
        return Err(fault("登录资料过长"));
    }
    if !request.proxy_url.is_empty() {
        let p = url::Url::parse(&request.proxy_url).map_err(|_| fault("代理地址无效"))?;
        if !["http", "https", "socks5", "socks5h"].contains(&p.scheme())
            || p.host_str().is_none()
            || p.query().is_some()
            || p.fragment().is_some()
            || p.path() != "/" && !p.path().is_empty()
            || request
                .proxy_url
                .chars()
                .any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(fault("请填写完整 HTTP、HTTPS 或 SOCKS5 代理地址"));
        }
    }
    let (queue, _) = host::load(host).await?;
    if !queue.enabled {
        return Err(fault("插件已关闭"));
    }
    let (mut records, version) = load(host).await?;
    if records.iter().any(|r| r.request_id == request.request_id) {
        return list(host).await;
    }
    if manager.email_change.is_some()
        || manager.worker.is_some()
        || queue.jobs.iter().any(|j| j.active())
    {
        return Err(fault("请等待当前任务结束后换绑"));
    }
    if records.len() >= 100 {
        return Err(fault("最多保存 100 条换绑记录，请先复制并清理旧记录"));
    }
    if records.iter().any(|r| {
        ["success", "review"].contains(&r.status.as_str())
            && (r.email.eq_ignore_ascii_case(&request.email)
                || r.new_email.eq_ignore_ascii_case(&request.new_email))
    }) {
        return Err(fault("该邮箱已有成功或待核对记录，请先检查历史记录"));
    }
    manager.runtime.prepare().await?;
    records.push(Record {
        request_id: request.request_id.clone(),
        email: request.email.clone(),
        new_email: request.new_email.clone(),
        status: "running".into(),
        step: "login".into(),
        message: "正在登录，换绑确认成功后保存新登录资料".into(),
        created_at: now(),
        credentials: None,
    });
    save(host, &records, version).await?;
    let worker = manager.runtime.start(json!({"mode":"change_email","email":request.email,"notes":format!("{}----{}----{}",request.email,request.password,request.totp_secret),"newEmail":request.new_email,"proxy":request.proxy_url}), String::new(), Value::Null, request.request_id).await;
    match worker {
        Ok(worker) => {
            manager.email_change = Some(Pending {
                worker,
                credentials,
            })
        }
        Err(error) => {
            let (mut records, version) = load(host).await?;
            if let Some(record) = records.last_mut() {
                record.status = "failed".into();
                record.message = "协议会话启动失败，尚未换绑".into();
            }
            save(host, &records, version).await?;
            return Err(error);
        }
    }
    list(host).await
}
pub async fn tick(manager: &mut Manager, host: &HostClient) -> Result<(), PluginFault> {
    let Some(pending) = manager.email_change.as_mut() else {
        return Ok(());
    };
    let (mut records, version) = load(host).await?;
    let record = records
        .iter_mut()
        .find(|r| r.request_id == pending.worker.request_id)
        .ok_or_else(|| fault("换绑记录不存在"))?;
    let (step, result, closed) = {
        let data = pending
            .worker
            .output
            .lock()
            .map_err(|_| fault("换绑状态读取失败"))?;
        (data.step.clone(), data.result.clone(), data.closed)
    };
    let old = (
        record.status.clone(),
        record.step.clone(),
        record.message.clone(),
    );
    if !step.is_empty() {
        record.step = step;
    }
    let ended = if let Some(result) = result {
        if result["event"] == "email_complete" {
            record.status = "success".into();
            record.credentials = Some(pending.credentials.clone());
            record.message = "邮箱换绑成功，新邮箱、原密码与原 2FA 密钥已保存".into();
        } else {
            let code = result["code"].as_str().unwrap_or_default();
            record.status = if record.credentials.is_some() {
                "review"
            } else {
                "failed"
            }
            .into();
            record.message = match code {
                "email_begin_rejected" => "发送换绑验证码被拒绝，请检查新邮箱及账号换绑资格",
                "email_verify_rejected" => "上游未确认换绑成功，请核对验证码及新旧邮箱状态",
                "email_verify_uncertain" => "确认请求结果不确定，请检查新旧邮箱，不会自动重试",
                _ => "登录或发送验证码失败，可能需要额外验证，请核对账号和代理",
            }
            .into();
            if let Some(status) = result["httpStatus"]
                .as_u64()
                .filter(|s| (100..=599).contains(s))
            {
                record.message.push_str(&format!("（HTTP {status}）"));
            }
        }
        true
    } else if now().saturating_sub(pending.worker.started) > 900_000 || closed {
        record.status = if record.credentials.is_some() {
            "review"
        } else {
            "interrupted"
        }
        .into();
        record.message = "会话已结束或超过 15 分钟，请先核对邮箱，不会自动重试".into();
        true
    } else {
        record.message = match record.step.as_str() {
            "email_login_code" => "请手动输入原邮箱收到的登录验证码",
            "email_code" => "换绑验证码已发送，请输入新邮箱收到的验证码",
            "email_verify" => "正在提交换绑确认，请等待结果",
            "email_begin" => "正在发送新邮箱换绑验证码",
            _ => "正在通过密码和 2FA 登录",
        }
        .into();
        false
    };
    if ended
        || old
            != (
                record.status.clone(),
                record.step.clone(),
                record.message.clone(),
            )
    {
        save(host, &records, version).await?;
    }
    if ended {
        manager.email_change.take();
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Action {
    request_id: String,
    #[serde(default)]
    code: String,
}
pub async fn action(
    manager: &mut Manager,
    host: &HostClient,
    path: &str,
    payload: &[u8],
) -> Result<Value, PluginFault> {
    let request: Action = serde_json::from_slice(payload).map_err(|_| fault("换绑操作参数无效"))?;
    let (mut records, version) = load(host).await?;
    let index = records
        .iter()
        .position(|r| r.request_id == request.request_id)
        .ok_or_else(|| fault("换绑记录不存在"))?;
    if path == "api/email-reveal" {
        return Ok(
            json!({"credentials":records[index].credentials.as_ref().ok_or_else(|| fault("尚无已保存的资料"))?}),
        );
    }
    if path == "api/email-delete" {
        if active(&records[index]) {
            return Err(fault("请先取消换绑会话"));
        }
        records.remove(index);
        save(host, &records, version).await?;
        return list(host).await;
    }
    let pending = manager
        .email_change
        .as_mut()
        .filter(|p| p.worker.request_id == request.request_id)
        .ok_or_else(|| fault("换绑会话已结束"))?;
    if path == "api/email-cancel" {
        records[index].status = if records[index].credentials.is_some() {
            "review"
        } else {
            "cancelled"
        }
        .into();
        records[index].message = "会话已取消，已发送的请求无法撤回，请核对邮箱状态".into();
        save(host, &records, version).await?;
        manager.email_change.take();
        return list(host).await;
    }
    if !host::load(host).await?.0.enabled {
        return Err(fault("插件已关闭"));
    }
    let step = pending
        .worker
        .output
        .lock()
        .map_err(|_| fault("换绑状态读取失败"))?
        .step
        .clone();
    if !["email_code", "email_login_code"].contains(&step.as_str())
        || records[index].step == "code_submitted"
        || records[index].status == "verifying"
    {
        return Err(fault("当前未等待验证码或验证码已经提交"));
    }
    if request.code.len() != 6 || !request.code.bytes().all(|c| c.is_ascii_digit()) {
        return Err(fault("请输入六位邮箱验证码"));
    }
    // 先保存待核对资料，再发送不可撤销的确认，重启或响应丢失时仍可取回
    if step == "email_code" {
        records[index].credentials = Some(pending.credentials.clone());
        records[index].status = "verifying".into();
    }
    records[index].step = "code_submitted".into();
    save(host, &records, version).await?;
    let bytes =
        serde_json::to_vec(&json!({"code":request.code})).map_err(|_| fault("验证码编码失败"))?;
    // 发送前清除旧等待阶段，避免覆盖子进程随后发出的新验证码提示
    pending
        .worker
        .output
        .lock()
        .map_err(|_| fault("换绑状态读取失败"))?
        .step = "running".into();
    let stdin = pending
        .worker
        .input
        .as_mut()
        .ok_or_else(|| fault("换绑会话不可用"))?;
    stdin
        .write_all(&bytes)
        .await
        .map_err(|_| fault("验证码提交结果不确定，请核对邮箱"))?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|_| fault("验证码提交结果不确定，请核对邮箱"))?;
    list(host).await
}
pub async fn cancel(manager: &mut Manager, host: &HostClient) -> Result<(), PluginFault> {
    if let Some(pending) = manager.email_change.as_ref() {
        let payload = serde_json::to_vec(&json!({"requestId":pending.worker.request_id}))
            .map_err(|_| fault("取消参数无效"))?;
        action(manager, host, "api/email-cancel", &payload).await?;
    }
    Ok(())
}
