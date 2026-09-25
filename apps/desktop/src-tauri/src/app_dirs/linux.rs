//! Linux XDG role resolution. Relative or empty XDG values are ignored, as the
//! base-directory contract requires; fallback needs an absolute, nonempty HOME.
//! Startup freezes a validated snapshot before workers or file consumers start,
//! so later environment edits cannot move one role away from its siblings.
//! No migration guesses are made: the former temp files remain untouched.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug)]
pub(super) enum Role { Config, Data, State, Runtime }

#[derive(Debug)]
struct Homes { config: PathBuf, data: PathBuf, state: PathBuf, runtime: PathBuf }

static HOMES: OnceLock<Homes> = OnceLock::new();

fn absolute(value: Option<OsString>) -> Option<PathBuf> {
    value.map(PathBuf::from).filter(|p| p.is_absolute())
}

fn resolve(role: Role, env: &impl Fn(&str) -> Option<OsString>) -> io::Result<PathBuf> {
    let (key, fallback) = match role {
        Role::Config => ("XDG_CONFIG_HOME", ".config"),
        Role::Data => ("XDG_DATA_HOME", ".local/share"),
        Role::State => ("XDG_STATE_HOME", ".local/state"),
        Role::Runtime => {
            return match absolute(env("XDG_RUNTIME_DIR")) {
                Some(base) => Ok(base.join(super::APP_DIR_NAME)),
                None => resolve(Role::State, env),
            };
        }
    };
    if let Some(base) = absolute(env(key)) {
        return Ok(base.join(super::APP_DIR_NAME));
    }
    let home = absolute(env("HOME")).ok_or_else(|| io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("Linux {key} is absent, empty or relative and HOME is not an absolute directory; refusing temporary application storage"),
    ))?;
    Ok(home.join(fallback).join(super::APP_DIR_NAME))
}

impl Homes {
    fn read(env: &impl Fn(&str) -> Option<OsString>) -> io::Result<Self> {
        Ok(Self {
            config: resolve(Role::Config, env)?, data: resolve(Role::Data, env)?,
            state: resolve(Role::State, env)?, runtime: resolve(Role::Runtime, env)?,
        })
    }

    fn path(&self, role: Role) -> &Path {
        match role {
            Role::Config => &self.config, Role::Data => &self.data,
            Role::State => &self.state, Role::Runtime => &self.runtime,
        }
    }
}

pub(super) fn initialize() -> io::Result<()> {
    if HOMES.get().is_none() {
        let homes = Homes::read(&|key| std::env::var_os(key))?;
        // Concurrent successful initializers agree to use the first snapshot.
        let _ = HOMES.set(homes);
    }
    Ok(())
}

pub(super) fn current(role: Role) -> io::Result<PathBuf> {
    match HOMES.get() {
        Some(homes) => Ok(homes.path(role).to_path_buf()),
        None => resolve(role, &|key| std::env::var_os(key)),
    }
}

pub(super) fn required(role: Role) -> PathBuf {
    // Production run() validates and freezes all roles before reaching any
    // infallible legacy PathBuf accessor. A direct caller outside that startup
    // contract gets a named failure, never a fabricated path.
    current(role).expect("Linux storage was not validated before a required file consumer")
}

#[cfg(test)]
mod tests;
