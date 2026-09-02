//! `nomoreide remote [pair|status|unpair]` — attaching this machine to an
//! account so it can be driven from a phone.
//!
//! `pair` is the only interactive command in the CLI: it prints a code, then
//! blocks until someone approves it on another device. That shape is
//! deliberate — the approval has to happen somewhere the machine cannot reach,
//! or the machine could approve itself.
//!
//! `unpair` is local only, and says so. Deleting the credential here stops this
//! daemon using it; it does not tell the platform anything. Only the owner
//! revoking from their account kills a credential for good, which is the whole
//! point of revocation not depending on a daemon's cooperation — a daemon that
//! has been abandoned, or is running an old build, or is simply not listening,
//! must still lose access the moment its owner says so.

use nomoreide_core::remote::credentials::{RemoteCredentials, StoredCredential};
use nomoreide_core::remote::pairing::{
    DeviceProposal, PairingError, PairingFlow, PairingStatus, PairingTicket, POLL_INTERVAL,
};

use crate::commands::{CliError, CliResult};
use crate::flags::parse_flags;

const USAGE: &str = "Usage: nomoreide remote [pair [--name=<name>]|status|unpair]";

pub async fn run(subcommand: Option<&str>, args: &[String]) -> CliResult {
    match subcommand {
        Some("pair") => pair(args).await,
        None | Some("status") => status().await,
        Some("unpair") => unpair(),
        _ => Err(CliError::usage(USAGE)),
    }
}

async fn pair(args: &[String]) -> CliResult {
    let flags = parse_flags(args);
    let flow = PairingFlow::discover();

    // Pairing twice would strand the first credential: the platform would hold
    // two devices for one machine, and only the newer one would ever be used.
    // Refusing is recoverable in one command; silently replacing is not.
    if let Some(existing) = flow.credentials().load() {
        return Err(CliError::usage(format!(
            "This machine is already paired as \"{}\".\n\
             Run `nomoreide remote unpair` first, or revoke it from your account.",
            existing.device_name
        )));
    }

    let proposal = DeviceProposal::for_this_machine(flags.truthy("name").map(str::to_string));
    let ticket = flow.start(&proposal).await.map_err(failure)?;

    println!("Pair this machine with your NoMoreIDE account.\n");
    println!("  Code: {}", ticket.user_code);
    println!("  Open: {}\n", ticket.verification_url);
    println!("Waiting for approval… (Ctrl-C to cancel)");

    wait_for_claim(&flow, &ticket).await?;
    let stored = flow.complete(&ticket).await.map_err(failure)?;

    println!("\nPaired as \"{}\".", stored.device_name);
    println!(
        "Credential saved to {}",
        flow.credentials().path().display()
    );
    Ok(())
}

/// Poll until a human approves, the pairing expires, or the user gives up.
///
/// A transport failure mid-wait is **not** fatal. A pairing lasts ten minutes
/// and a phone-tethered laptop drops packets; giving up on the first refused
/// connection would make pairing fail for exactly the users most likely to want
/// remote control. A refusal from the platform itself is different, and stops.
async fn wait_for_claim(flow: &PairingFlow, ticket: &PairingTicket) -> Result<(), CliError> {
    loop {
        match flow.poll(ticket).await {
            Ok(state) => match state.status {
                PairingStatus::Claimed => return Ok(()),
                PairingStatus::Exchanged => {
                    return Err(CliError::Failure(
                        "That pairing was already completed by another process.".to_string(),
                    ));
                }
                PairingStatus::Expired => return Err(failure(PairingError::Expired)),
                PairingStatus::Pending => {}
            },
            Err(PairingError::Unreachable(_)) => {}
            Err(error) => return Err(failure(error)),
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// What this machine's pairing looks like from here.
///
/// Deliberately says three separate things: whether a credential exists,
/// whether the platform still accepts it, and whether the file is private. A
/// revoked credential and an unreachable platform look identical to a naive
/// check, and telling them apart is the difference between "your machine was
/// removed from your account" and "your wifi is down".
async fn status() -> CliResult {
    let flow = PairingFlow::discover();
    let credentials = flow.credentials();
    let Some(stored) = credentials.load() else {
        println!("Not paired.");
        println!("Run `nomoreide remote pair` to control this machine from your phone.");
        return Ok(());
    };

    println!("Paired as \"{}\"", stored.device_name);
    println!("  Device:   {}", stored.device_id);
    println!("  Platform: {}", stored.platform_base_url);
    println!("  Since:    {}", stored.paired_at);
    println!("  Stored:   {}", credentials.path().display());

    if credentials.is_world_readable() {
        println!(
            "\n  Warning: {} is readable by other users on this machine.\n  \
             Run `chmod 600 {}` to fix it.",
            credentials.path().display(),
            credentials.path().display()
        );
    }

    if stored.platform_base_url.trim_end_matches('/') != flow.base_url() {
        println!(
            "\n  Note: this credential was issued by {}, but this machine is\n  \
             configured to talk to {}. Remote control will not work until the\n  \
             two agree — pair again, or unset NOMOREIDE_API_BASE_URL.",
            stored.platform_base_url,
            flow.base_url()
        );
    }

    Ok(())
}

fn unpair() -> CliResult {
    let credentials = RemoteCredentials::discover();
    let previous: Option<StoredCredential> = credentials.load();
    let removed = credentials
        .clear()
        .map_err(|error| CliError::Failure(format!("Could not remove the credential: {error}")))?;

    match (removed, previous) {
        (true, Some(stored)) => {
            println!("Unpaired \"{}\" on this machine.", stored.device_name);
            println!(
                "The platform still lists it until you revoke it from your account —\n\
                 removing the file here stops this daemon using it, nothing more."
            );
        }
        (true, None) => println!("Removed an unreadable credential file."),
        (false, _) => println!("This machine is not paired."),
    }
    Ok(())
}

fn failure(error: PairingError) -> CliError {
    match error {
        // A refusal is the platform's considered answer, and its own wording is
        // better than anything reconstructed here.
        PairingError::Refused { .. } | PairingError::Expired => CliError::usage(error.to_string()),
        other => CliError::Failure(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_unknown_subcommand_is_a_usage_error() {
        let error = run(Some("teleport"), &[]).await.expect_err("should refuse");

        assert!(matches!(error, CliError::Usage(_)));
    }

    /// A platform refusal is the caller's problem (exit 1), not the machine's
    /// (exit 2) — scripts branch on that difference.
    #[test]
    fn a_platform_refusal_is_a_usage_failure() {
        let error = failure(PairingError::Refused {
            status: 404,
            message: "That pairing code is not valid.".to_string(),
        });

        assert!(matches!(error, CliError::Usage(_)));
        assert_eq!(error.exit_code(), 1);
    }

    /// An unreachable platform is not the caller's mistake.
    #[test]
    fn an_unreachable_platform_is_a_hard_failure() {
        let error = failure(PairingError::Unreachable("connection refused".to_string()));

        assert!(matches!(error, CliError::Failure(_)));
        assert_eq!(error.exit_code(), 2);
    }

    /// The message a user sees when a pairing runs out has to say what to do
    /// next, because there is nothing on screen by then but a dead code.
    #[test]
    fn an_expired_pairing_says_how_to_start_again() {
        let message = PairingError::Expired.to_string();

        assert!(message.contains("nomoreide remote pair"), "{message}");
    }
}
