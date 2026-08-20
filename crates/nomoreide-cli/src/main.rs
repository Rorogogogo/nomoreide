use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    match (args.next().as_deref(), args.next()) {
        (Some(command), None) if command == "mcp" => match nomoreide_mcp::run_stdio() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("nomoreide: MCP server failed: {error}");
                ExitCode::FAILURE
            }
        },
        _ => {
            eprintln!("Usage: nomoreide mcp");
            ExitCode::FAILURE
        }
    }
}
