// Prevents a Windows console window from appearing on release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--terminal-attach") {
        let result = match (args.get(2), args.get(3), args.get(4)) {
            (Some(socket), Some(token), None) => nomoreide_lib::run_terminal_attach(socket, token),
            _ => Err("Invalid internal terminal attachment arguments".to_string()),
        };
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    nomoreide_lib::run();
}
