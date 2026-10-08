//! Marketplace tokens at rest: AES-256-GCM with a key from the environment
//! (`CARDRAILS_SECRET_KEY`, 32 bytes base64), never stored in the database.
//! Layout: 12-byte nonce followed by the ciphertext and tag.

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, Nonce};
use base64::Engine;

const NONCE_BYTES: usize = 12;

pub fn parse_key(raw: &str) -> anyhow::Result<[u8; 32]> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|_| anyhow::anyhow!("CARDRAILS_SECRET_KEY must be base64"))?;
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("CARDRAILS_SECRET_KEY must decode to 32 bytes"))
}

pub fn encrypt(key: &[u8; 32], plaintext: &str) -> anyhow::Result<Vec<u8>> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let mut out = nonce.to_vec();
    out.extend(
        cipher
            .encrypt(&nonce, plaintext.as_bytes())
            .map_err(|_| anyhow::anyhow!("encryption failed"))?,
    );
    Ok(out)
}

pub fn decrypt(key: &[u8; 32], data: &[u8]) -> anyhow::Result<String> {
    if data.len() <= NONCE_BYTES {
        anyhow::bail!("ciphertext too short");
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let (nonce, body) = data.split_at(NONCE_BYTES);
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce), body)
        .map_err(|_| anyhow::anyhow!("decryption failed"))?;
    Ok(String::from_utf8(plain)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_tamper() {
        let key = [7u8; 32];
        let sealed = encrypt(&key, "token-value").unwrap();
        assert_eq!(decrypt(&key, &sealed).unwrap(), "token-value");
        assert_ne!(encrypt(&key, "token-value").unwrap(), sealed, "fresh nonce each time");
        let mut bad = sealed.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(decrypt(&key, &bad).is_err());
        assert!(decrypt(&[8u8; 32], &sealed).is_err());
    }
}
