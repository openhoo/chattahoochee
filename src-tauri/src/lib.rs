mod account_http;

use account_http::{
    AccountHttpBroker, AccountHttpResponse, BodyEncoding, BrokerError, BrokerRequest,
};
use tauri::{webview::NewWindowResponse, Manager, State, WebviewWindow, WebviewWindowBuilder};
use url::Url;

fn require_main_window(window: &WebviewWindow) -> Result<(), BrokerError> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(BrokerError::new(
            "window_denied",
            "This command is only available to the main window.",
        ))
    }
}

#[tauri::command(rename_all = "camelCase")]
fn configure_account_transport(
    window: WebviewWindow,
    state: State<'_, AccountHttpBroker>,
    account_id: String,
    origins: Vec<String>,
) -> Result<(), BrokerError> {
    require_main_window(&window)?;
    state.configure(&account_id, origins)
}

#[tauri::command(rename_all = "camelCase")]
async fn account_http(
    window: WebviewWindow,
    state: State<'_, AccountHttpBroker>,
    account_id: String,
    request_id: String,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    body_encoding: Option<BodyEncoding>,
) -> Result<AccountHttpResponse, BrokerError> {
    require_main_window(&window)?;
    state
        .request(BrokerRequest {
            account_id,
            request_id,
            url,
            method,
            headers,
            body,
            body_encoding: body_encoding.unwrap_or(BodyEncoding::Utf8),
        })
        .await
}

#[tauri::command(rename_all = "camelCase")]
fn cancel_account_http(
    window: WebviewWindow,
    state: State<'_, AccountHttpBroker>,
    account_id: String,
    request_id: String,
) -> Result<(), BrokerError> {
    require_main_window(&window)?;
    state.cancel(&account_id, &request_id)
}

#[tauri::command(rename_all = "camelCase")]
fn remove_account_transport(
    window: WebviewWindow,
    state: State<'_, AccountHttpBroker>,
    account_id: String,
) -> Result<(), BrokerError> {
    require_main_window(&window)?;
    state.remove(&account_id)
}

fn allowed_navigation(url: &Url, dev_origin: Option<&str>) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let packaged =
        (url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none())
            || (url.scheme() == "https"
                && url.host_str() == Some("tauri.localhost")
                && url.port().is_none());
    packaged || dev_origin.is_some_and(|origin| url.origin().ascii_serialization() == origin)
}

pub fn run() {
    let broker =
        AccountHttpBroker::new().expect("Unable to initialize the native account transport");
    tauri::Builder::default()
        .manage(broker)
        .invoke_handler(tauri::generate_handler![
            configure_account_transport,
            account_http,
            cancel_account_http,
            remove_account_transport
        ])
        .setup(|app| {
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or("The main window configuration is missing")?;
            let dev_origin = if cfg!(debug_assertions) {
                app.config()
                    .build
                    .dev_url
                    .as_ref()
                    .map(|url| url.origin().ascii_serialization())
            } else {
                None
            };
            WebviewWindowBuilder::from_config(app, config)?
                .on_navigation(move |url| allowed_navigation(url, dev_origin.as_deref()))
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Unable to start Chattahoochee")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                app.state::<AccountHttpBroker>().cancel_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_stays_in_the_packaged_app_or_exact_development_origin() {
        for url in [
            "tauri://localhost/index.html",
            "https://tauri.localhost/settings",
        ] {
            assert!(allowed_navigation(&Url::parse(url).unwrap(), None));
        }
        for url in [
            "https://example.com",
            "http://tauri.localhost",
            "https://tauri.localhost.example.com",
            "https://user@tauri.localhost",
            "file:///etc/passwd",
            "data:text/html,hello",
        ] {
            assert!(!allowed_navigation(&Url::parse(url).unwrap(), None));
        }
        let dev = Some("http://127.0.0.1:1420");
        assert!(allowed_navigation(
            &Url::parse("http://127.0.0.1:1420/settings").unwrap(),
            dev
        ));
        assert!(!allowed_navigation(
            &Url::parse("http://127.0.0.1:1421").unwrap(),
            dev
        ));
        assert!(!allowed_navigation(
            &Url::parse("http://localhost:1420").unwrap(),
            dev
        ));
    }
}
