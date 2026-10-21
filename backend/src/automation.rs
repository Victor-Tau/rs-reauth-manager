//! 持久化自动授权筛选、扫描与冷却，不重放不确定写回
use crate::{
    Job, Queue,
    host::{fault, now},
    rows,
};
use gateway_plugin_sdk::{PluginFault, client::HostClient};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const BLOCKED: u64 = 9_007_199_254_740_991;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Automation {
    pub enabled: bool,
    pub interval_minutes: u64,
    pub cooldown_hours: u64,
    pub all_groups: bool,
    pub group_ids: Vec<String>,
    pub include_ungrouped: bool,
    pub statuses: Vec<String>,
    pub all_plans: bool,
    pub plans: Vec<String>,
    pub enabled_only: bool,
}
impl Default for Automation {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_minutes: 15,
            cooldown_hours: 24,
            all_groups: true,
            group_ids: vec![],
            include_ungrouped: true,
            statuses: vec!["error".into()],
            all_plans: true,
            plans: vec![],
            enabled_only: true,
        }
    }
}
impl Automation {
    pub fn validate(&self) -> Result<(), PluginFault> {
        if !(1..=1440).contains(&self.interval_minutes)
            || !(1..=168).contains(&self.cooldown_hours)
            || self.group_ids.len() > 100
            || self.plans.len() > 100
            || self.statuses.is_empty()
            || self.statuses.len() > 10
            || self.statuses.iter().any(|s| {
                !["normal", "error", "quota_exhausted", "rate_limited"].contains(&s.as_str())
            })
            || self
                .group_ids
                .iter()
                .chain(self.plans.iter())
                .any(|v| v.is_empty() || v.len() > 128 || v.chars().any(char::is_control))
            || (!self.all_groups && self.group_ids.is_empty() && !self.include_ungrouped)
            || (!self.all_plans && self.plans.is_empty())
        {
            return Err(fault(
                "自动授权参数无效，请选择分组、状态及订阅，检查扫描间隔与冷却时间",
            ));
        }
        Ok(())
    }
    pub fn matches(&self, a: &Value) -> bool {
        let Some(groups) = a["groups"].as_array() else {
            return false;
        };
        let plan = a["planType"]
            .as_str()
            .unwrap_or("unknown")
            .trim()
            .to_lowercase();
        (!self.enabled_only || a["enabled"] == true)
            && self.statuses.iter().any(|s| a["status"] == *s)
            && (self.all_plans || self.plans.contains(&plan))
            && (self.all_groups
                || groups.is_empty() && self.include_ungrouped
                || groups
                    .iter()
                    .any(|g| self.group_ids.iter().any(|id| g["id"] == *id)))
    }
}
pub async fn scan(host: &HostClient, queue: &mut Queue) -> Result<bool, PluginFault> {
    let time = now();
    if !queue.enabled
        || !queue.automation.enabled
        || time.saturating_sub(queue.last_scan_at) < queue.automation.interval_minutes * 60000
    {
        return Ok(false);
    }
    let data = rows(host).await?;
    queue.last_scan_at = time;
    let cooldown = queue.automation.cooldown_hours * 3600000;
    // 保留不确定结果的阻止标记，直到手动授权成功
    let all = data["accounts"]
        .as_array()
        .ok_or_else(|| fault("账号列表格式无效"))?;
    queue.auto_attempts.retain(|id, stamp| {
        all.iter().any(|a| a["id"] == *id)
            && (*stamp == BLOCKED || time.saturating_sub(*stamp) < cooldown)
    });
    let mut slots = 100usize.saturating_sub(queue.jobs.iter().filter(|j| j.active()).count());
    for a in all {
        let Some(id) = a["id"].as_str() else { continue };
        if slots == 0 || queue.auto_attempts.len() >= 1000 {
            break;
        }
        if !queue.automation.matches(a)
            || a["notesValid"] != true
            || a["proxy"].as_str().is_none_or(str::is_empty)
            || queue.auto_attempts.contains_key(id)
            || queue.jobs.iter().any(|j| j.account_id == id && j.active())
            || queue
                .jobs
                .iter()
                .rev()
                .find(|j| j.account_id == id)
                .is_some_and(|j| ["review", "interrupted"].contains(&j.status.as_str()))
        {
            continue;
        }
        queue.jobs.push(Job::queued(
            format!("auto-{}:{id}", uuid::Uuid::new_v4()),
            id.into(),
            true,
        ));
        queue.auto_attempts.insert(id.into(), time);
        slots -= 1;
    }
    crate::trim_jobs(queue);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn selection_intersects_dimensions_and_unions_groups() {
        let mut c = Automation {
            all_groups: false,
            group_ids: vec!["g2".into()],
            include_ungrouped: false,
            all_plans: false,
            plans: vec!["free".into()],
            ..Automation::default()
        };
        let mut a = json!({"enabled":true,"status":"error","planType":" Free ","groups":[{"id":"g1"},{"id":"g2"}]});
        assert!(c.matches(&a));
        a["status"] = json!("normal");
        assert!(!c.matches(&a));
        a["status"] = json!("error");
        a["groups"] = json!([]);
        assert!(!c.matches(&a));
        c.include_ungrouped = true;
        assert!(c.matches(&a));
        a["enabled"] = json!(false);
        assert!(!c.matches(&a));
        c.enabled_only = false;
        assert!(c.matches(&a));
        a["planType"] = json!("plus");
        assert!(!c.matches(&a));
    }
    #[test]
    fn empty_explicit_selections_and_invalid_intervals_are_rejected() {
        let mut c = Automation::default();
        assert!(c.validate().is_ok());
        c.all_plans = false;
        assert!(c.validate().is_err());
        c.plans.push("free".into());
        assert!(c.validate().is_ok());
        c.interval_minutes = 0;
        assert!(c.validate().is_err());
    }
}
