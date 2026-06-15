// Prevents a Windows console window from appearing on release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nomoreide_lib::run();
}
