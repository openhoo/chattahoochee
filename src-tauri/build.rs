const COMMANDS: &[&str] = &[
    "configure_account_transport",
    "account_http",
    "cancel_account_http",
    "remove_account_transport",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("Unable to configure Chattahoochee native permissions");
}
