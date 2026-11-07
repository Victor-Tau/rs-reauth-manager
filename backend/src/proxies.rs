//! 通过公开代理目录与精确账号关联确认启用状态，保存无认证信息的版本快照

use crate::host::{admin, fault, query};
use gateway_plugin_sdk::{PluginFault, client::HostClient};
use serde::Deserialize;
use serde_json::{Value, json};

const INVALID: &str = "账号代理状态无法确认，已停止操作";
const MAX_PAGES: u64 = 100;

#[derive(Deserialize)]
struct Page<T> {
    items: Vec<T>,
    page: Pagination,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pagination {
    page: u64,
    total_pages: u64,
}

impl Pagination {
    fn last(&self, requested: u64, empty: bool) -> Result<bool, PluginFault> {
        if self.page != requested
            || self.total_pages > MAX_PAGES
            || (self.total_pages < requested && !(self.total_pages == 0 && requested == 1 && empty))
        {
            return Err(fault(INVALID));
        }
        Ok(requested >= self.total_pages)
    }
}

#[derive(Deserialize)]
struct Proxy {
    id: String,
    endpoint: String,
    enabled: bool,
    revision: u64,
}

#[derive(Deserialize)]
struct Account {
    id: String,
}

async fn contains_account(
    host: &HostClient,
    proxy_id: &str,
    account_id: &str,
    email: &str,
) -> Result<bool, PluginFault> {
    for page in 1..=MAX_PAGES {
        let value = admin(
            host,
            "GET",
            &query(
                "/api/admin/proxies/accounts",
                &[
                    ("proxyId", proxy_id),
                    ("search", email),
                    ("page", &page.to_string()),
                    ("pageSize", "200"),
                ],
            ),
            None,
        )
        .await?;
        let data: Page<Account> = serde_json::from_value(value).map_err(|_| fault(INVALID))?;
        let last = data.page.last(page, data.items.is_empty())?;
        if data.items.iter().any(|account| account.id == account_id) {
            return Ok(true);
        }
        if last {
            return Ok(false);
        }
    }
    Err(fault(INVALID))
}

// 只有宿主明确返回空代理时才是直连；缺失或格式异常不能作为直连降级
pub fn endpoint(account: &Value) -> Result<Option<&str>, PluginFault> {
    match account.get("outboundProxyEndpoint") {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.is_empty() => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        _ => Err(fault(INVALID)),
    }
}

pub async fn binding(host: &HostClient, account: &Value) -> Result<Value, PluginFault> {
    let Some(endpoint) = endpoint(account)? else {
        return Ok(Value::Null);
    };
    let id = account["id"].as_str().ok_or_else(|| fault(INVALID))?;
    let email = account["email"].as_str().ok_or_else(|| fault(INVALID))?;
    let mut binding = None;
    for page in 1..=MAX_PAGES {
        let value = admin(
            host,
            "GET",
            &query(
                "/api/admin/proxies",
                &[("page", &page.to_string()), ("pageSize", "200")],
            ),
            None,
        )
        .await?;
        let data: Page<Proxy> = serde_json::from_value(value).map_err(|_| fault(INVALID))?;
        let last = data.page.last(page, data.items.is_empty())?;
        for proxy in data.items.iter().filter(|proxy| proxy.endpoint == endpoint) {
            // 同一 endpoint 可对应不同认证信息，必须查到精确账号关联才能选定代理
            if !contains_account(host, &proxy.id, id, email).await? {
                continue;
            }
            if !proxy.enabled {
                return Err(fault("原账号绑定代理已禁用，请启用后重试；不会改用直连"));
            }
            if proxy.id.is_empty() || proxy.revision == 0 || binding.is_some() {
                return Err(fault(INVALID));
            }
            binding = Some(json!({"id":proxy.id,"revision":proxy.revision}));
        }
        if last {
            return binding.ok_or_else(|| fault(INVALID));
        }
    }
    Err(fault(INVALID))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_empty_proxy_is_direct() {
        for value in [Value::Null, json!("")] {
            assert_eq!(
                endpoint(&json!({"outboundProxyEndpoint": value})).unwrap(),
                None
            );
        }
        assert_eq!(
            endpoint(&json!({"outboundProxyEndpoint": "http://127.0.0.1:21001"})).unwrap(),
            Some("http://127.0.0.1:21001")
        );
        for account in [json!({}), json!({"outboundProxyEndpoint": false})] {
            assert!(endpoint(&account).is_err());
        }
    }
}
