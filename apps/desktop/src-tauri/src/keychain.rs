use serde_json::{json, Value};
use std::io::{self, Read};

pub const HELPER_ARG: &str = "--keychain-helper";

pub fn run() -> Result<(), ()> {
    let mut request = String::new();
    io::stdin()
        .take(16_385)
        .read_to_string(&mut request)
        .map_err(|_| ())?;
    if request.len() > 16_384 {
        return Err(());
    }
    let command: Value = serde_json::from_str(&request).map_err(|_| ())?;
    let account = command["account"]
        .as_str()
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or(())?;
    let entry = keyring::Entry::new("dev.masterakbari.assentor", account).map_err(|_| ())?;
    let result = match command["op"].as_str() {
        Some("get") => match entry.get_password() {
            Ok(secret) => json!({"secret": secret}),
            Err(keyring::Error::NoEntry) => json!({"missing":true}),
            Err(_) => return Err(()),
        },
        Some("set") => {
            let secret = command["secret"]
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or(())?;
            entry.set_password(secret).map_err(|_| ())?;
            json!({"ok":true})
        }
        Some("delete") => {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => (),
                Err(_) => return Err(()),
            }
            json!({"ok":true})
        }
        _ => return Err(()),
    };
    println!("{result}");
    Ok(())
}
