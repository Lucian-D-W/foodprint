use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{error::AppResult, paths::PathResolver};

#[derive(Deserialize)]
struct MapManifest {
    #[serde(rename = "packageVersion")]
    version: String,
    sha256: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct IconManifest {
    #[serde(rename = "assetVersion")]
    version: String,
    icons: BTreeMap<String, Asset>,
    overlays: BTreeMap<String, Asset>,
}

#[derive(Deserialize)]
struct Asset {
    src: String,
    sha256: String,
}

pub fn install(paths: &PathResolver, source_root: &Path) -> AppResult<()> {
    install_one(
        &source_root.join("map-default"),
        &paths.root().join("maps/default"),
        Package::Map,
    )?;
    install_one(
        &source_root.join("food-icons"),
        &paths.root().join("assets/food-icons"),
        Package::Icons,
    )
}

#[derive(Clone, Copy)]
enum Package {
    Map,
    Icons,
}

impl Package {
    fn manifest(self, root: &Path) -> AppResult<(String, Vec<(PathBuf, String)>)> {
        let text = fs::read_to_string(root.join("manifest.json"))?;
        match self {
            Self::Map => {
                let manifest: MapManifest = json(&text)?;
                Ok((
                    manifest.version,
                    manifest
                        .sha256
                        .into_iter()
                        .map(|(path, hash)| safe_path(&path).map(|path| (path, hash)))
                        .collect::<Result<_, _>>()?,
                ))
            }
            Self::Icons => {
                let manifest: IconManifest = json(&text)?;
                let assets = manifest
                    .icons
                    .into_values()
                    .chain(manifest.overlays.into_values())
                    .map(|asset| Ok((safe_path(&asset.src)?, asset.sha256)))
                    .collect::<AppResult<Vec<_>>>()?;
                Ok((manifest.version, assets))
            }
        }
    }
}

fn json<T: for<'a> Deserialize<'a>>(text: &str) -> AppResult<T> {
    serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(std::io::Error::other)
        .map_err(Into::into)
}

fn safe_path(path: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(path);
    if path
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(std::io::Error::other("unsafe asset manifest path").into());
    }
    Ok(path)
}

fn verified(root: &Path, package: Package) -> AppResult<(String, bool)> {
    let (version, files) = package.manifest(root)?;
    let valid = files.into_iter().all(|(path, expected)| {
        hash(&root.join(path)).is_ok_and(|actual| actual.eq_ignore_ascii_case(&expected))
    });
    Ok((version, valid))
}

fn hash(path: &Path) -> AppResult<String> {
    let bytes = fs::read(path)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn install_one(source: &Path, destination: &Path, package: Package) -> AppResult<()> {
    let (version, source_valid) = verified(source, package)?;
    if !source_valid {
        return Err(std::io::Error::other("shipped asset hash mismatch").into());
    }
    if let Ok((installed_version, installed_valid)) = verified(destination, package) {
        if installed_version == version && installed_valid {
            return Ok(());
        }
    }
    let staging = destination.with_extension("staging");
    let backup = destination.with_extension("previous");
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    if backup.exists() {
        fs::remove_dir_all(&backup)?;
    }
    copy_tree(source, &staging)?;
    if !verified(&staging, package)?.1 {
        fs::remove_dir_all(&staging)?;
        return Err(std::io::Error::other("staged asset hash mismatch").into());
    }
    if destination.exists() {
        fs::rename(destination, &backup)?;
    }
    if let Err(error) = fs::rename(&staging, destination) {
        if backup.exists() {
            let _ = fs::rename(&backup, destination);
        }
        return Err(error.into());
    }
    if backup.exists() {
        fs::remove_dir_all(backup)?;
    }
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> AppResult<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}
