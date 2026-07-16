use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use std::env;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;
use std::process;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 {
        return Err("usage: raven-signature-verify <artifact> <signature> <public-key>".into());
    }
    let artifact_path = Path::new(&args[1]);
    let signature = load_signature(&args[2])?;
    let public_key = load_public_key(&args[3])?;
    let mut verifier = public_key
        .verify_stream(&signature)
        .map_err(|_| "signature is incompatible with the public key".to_string())?;
    let mut artifact =
        File::open(artifact_path).map_err(|_| "artifact file could not be opened".to_string())?;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = artifact
            .read(&mut buffer)
            .map_err(|_| "artifact file could not be read".to_string())?;
        if count == 0 {
            break;
        }
        verifier.update(&buffer[..count]);
    }
    verifier
        .finalize()
        .map_err(|_| "artifact signature verification failed".to_string())?;
    println!("{{\"verified\":true}}");
    Ok(())
}

fn load_public_key(value: &str) -> Result<PublicKey, String> {
    let content = if Path::new(value).is_file() {
        fs::read_to_string(value).map_err(|_| "public key file could not be read".to_string())?
    } else {
        value.to_string()
    };
    let trimmed = content.trim();
    if trimmed.contains('\n') || trimmed.contains('\r') {
        return PublicKey::decode(trimmed).map_err(|_| "public key is invalid".to_string());
    }
    if let Ok(key) = PublicKey::from_base64(trimmed) {
        return Ok(key);
    }
    let decoded = STANDARD
        .decode(trimmed)
        .map_err(|_| "public key is invalid".to_string())?;
    let text = String::from_utf8(decoded).map_err(|_| "public key is invalid".to_string())?;
    PublicKey::decode(text.trim()).map_err(|_| "public key is invalid".to_string())
}

fn load_signature(value: &str) -> Result<Signature, String> {
    let content =
        fs::read_to_string(value).map_err(|_| "signature file could not be read".to_string())?;
    let trimmed = content.trim();
    if let Ok(signature) = Signature::decode(trimmed) {
        return Ok(signature);
    }
    let decoded = STANDARD
        .decode(trimmed)
        .map_err(|_| "signature file is invalid".to_string())?;
    let text = String::from_utf8(decoded).map_err(|_| "signature file is invalid".to_string())?;
    Signature::decode(text.trim()).map_err(|_| "signature file is invalid".to_string())
}
