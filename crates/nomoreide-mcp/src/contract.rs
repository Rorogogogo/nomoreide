use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::OnceLock;

// Staged into `OUT_DIR` by `build.rs`. The fixture itself lives at the
// workspace root, shared with the parity harness, and a packaged crate does
// not carry anything above its own directory.
const FROZEN_CONTRACT: &str = include_str!(concat!(env!("OUT_DIR"), "/mcp-contract-v1.json"));

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrozenContract {
    contract_version: u64,
    initialize: Value,
    tools: Vec<Value>,
}

pub(crate) struct ToolRegistry {
    initialize: Value,
    tools: Vec<Value>,
    names: HashSet<String>,
}

impl ToolRegistry {
    fn from_frozen_contract() -> Result<Self, String> {
        let contract: FrozenContract =
            serde_json::from_str(FROZEN_CONTRACT).map_err(|error| error.to_string())?;
        if contract.contract_version != 1 {
            return Err(format!(
                "unsupported frozen MCP contract version {}",
                contract.contract_version
            ));
        }
        if contract.tools.len() != 90 {
            return Err(format!(
                "frozen MCP contract contains {} tools instead of 90",
                contract.tools.len()
            ));
        }

        let mut names = HashSet::with_capacity(contract.tools.len());
        for tool in &contract.tools {
            let name = tool
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| "frozen MCP tool is missing a string name".to_string())?;
            if !names.insert(name.to_string()) {
                return Err(format!("frozen MCP tool name is duplicated: {name}"));
            }
            if tool.get("description").and_then(Value::as_str).is_none() {
                return Err(format!("frozen MCP tool {name} is missing a description"));
            }
            if !tool.get("inputSchema").is_some_and(Value::is_object) {
                return Err(format!("frozen MCP tool {name} has no object input schema"));
            }
        }

        Ok(Self {
            initialize: contract.initialize,
            tools: contract.tools,
            names,
        })
    }

    pub(crate) fn initialize(&self) -> &Value {
        &self.initialize
    }

    pub(crate) fn tools(&self) -> &[Value] {
        &self.tools
    }

    pub(crate) fn contains(&self, name: &str) -> bool {
        self.names.contains(name)
    }
}

pub(crate) fn registry() -> &'static ToolRegistry {
    static REGISTRY: OnceLock<ToolRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        ToolRegistry::from_frozen_contract()
            .expect("the embedded MCP compatibility contract must be valid")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frozen_registry_has_exactly_ninety_unique_tools() {
        let registry = registry();
        assert_eq!(registry.tools().len(), 90);
        assert_eq!(registry.names.len(), 90);
        assert_eq!(registry.tools()[0]["name"], "nomoreide_list_services");
        assert_eq!(registry.tools()[89]["name"], "nomoreide_reclaim_terminal");
    }
}
