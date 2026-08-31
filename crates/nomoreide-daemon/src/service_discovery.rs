use anyhow::{bail, Context, Result};
use nomoreide_core::config::{Config, ServiceDef};
use nomoreide_daemon_client::protocol::{
    BundleDefinition, DockerComposeServiceDefinition, LocalServiceDefinition, ServiceDefinition,
    ServiceDiscovery, SshServiceDefinition,
};

pub(crate) fn build_service_discovery(config: &Config) -> Result<ServiceDiscovery> {
    let services = config
        .services
        .iter()
        .map(map_service)
        .collect::<Result<Vec<_>>>()?;
    let bundles = config
        .bundles
        .iter()
        .map(|bundle| BundleDefinition {
            name: bundle.name.clone(),
            services: bundle.services.clone(),
        })
        .collect();
    Ok(ServiceDiscovery { services, bundles })
}

fn map_service(service: &ServiceDef) -> Result<ServiceDefinition> {
    match service.effective_kind() {
        "local" => Ok(ServiceDefinition::Local(LocalServiceDefinition {
            name: service.name.clone(),
            port: service.port,
            description: service.description.clone(),
            test: service.test.clone(),
            depends_on: service.depends_on.clone(),
            project_path: service.project_path.clone(),
            kind: service.kind.clone(),
            command: required(service.command.as_ref(), service, "command")?,
            args: service.args.clone(),
            cwd: required(service.cwd.as_ref(), service, "cwd")?,
            env_keys: env_keys(service),
        })),
        "docker-compose" => Ok(ServiceDefinition::DockerCompose(
            DockerComposeServiceDefinition {
                name: service.name.clone(),
                port: service.port,
                description: service.description.clone(),
                test: service.test.clone(),
                depends_on: service.depends_on.clone(),
                project_path: service.project_path.clone(),
                kind: "docker-compose".into(),
                cwd: required(service.cwd.as_ref(), service, "cwd")?,
                compose_file: service.compose_file.clone(),
                compose_service: required(
                    service.compose_service.as_ref(),
                    service,
                    "composeService",
                )?,
            },
        )),
        "ssh" => Ok(ServiceDefinition::Ssh(SshServiceDefinition {
            name: service.name.clone(),
            port: service.port,
            description: service.description.clone(),
            test: service.test.clone(),
            depends_on: service.depends_on.clone(),
            project_path: service.project_path.clone(),
            kind: "ssh".into(),
            host: required(service.host.as_ref(), service, "host")?,
            cwd: required(service.cwd.as_ref(), service, "cwd")?,
            command: required(service.command.as_ref(), service, "command")?,
            env_keys: env_keys(service),
        })),
        kind => bail!("Service {:?} has unsupported kind {kind:?}.", service.name),
    }
}

fn required(value: Option<&String>, service: &ServiceDef, field: &str) -> Result<String> {
    value
        .filter(|value| !value.is_empty())
        .cloned()
        .with_context(|| format!("Service {:?} is missing {field}.", service.name))
}

fn env_keys(service: &ServiceDef) -> Option<Vec<String>> {
    service.env.as_ref().map(|env| {
        let mut keys = env.keys().cloned().collect::<Vec<_>>();
        keys.sort();
        keys
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nomoreide_core::config::{BundleDef, ServiceDef};
    use std::collections::HashMap;

    #[test]
    fn discovery_preserves_kind_omission_and_redacts_environment_values() {
        let mut config = Config::default();
        config.services.push(ServiceDef {
            name: "api".into(),
            kind: None,
            command: Some("node".into()),
            args: Some(vec!["server.js".into()]),
            cwd: Some("/repo".into()),
            port: Some(3000),
            description: None,
            project_path: None,
            env: Some(HashMap::from([
                ("Z_TOKEN".into(), "secret".into()),
                ("A_MODE".into(), "development".into()),
            ])),
            test: None,
            depends_on: None,
            compose_file: None,
            compose_service: None,
            host: None,
        });
        config.bundles.push(BundleDef {
            name: "app".into(),
            services: vec!["api".into()],
        });

        let discovery = build_service_discovery(&config).unwrap();
        let serialized = serde_json::to_string(&discovery).unwrap();
        assert_eq!(
            discovery.services,
            vec![ServiceDefinition::Local(LocalServiceDefinition {
                name: "api".into(),
                port: Some(3000),
                description: None,
                test: None,
                depends_on: None,
                project_path: None,
                kind: None,
                command: "node".into(),
                args: Some(vec!["server.js".into()]),
                cwd: "/repo".into(),
                env_keys: Some(vec!["A_MODE".into(), "Z_TOKEN".into()]),
            })]
        );
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("development"));
        assert!(!serialized.contains("\"kind\""));
    }
}
