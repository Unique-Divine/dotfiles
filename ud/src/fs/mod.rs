//! Built-in public-file publishing and listing through the owner's Google login.
//!
//! Planning and formatting are independent of cloud access. Only explicit
//! publishing uploads bytes; listing reads metadata, and dry runs stay local.
mod backend;
mod cli;
mod config;
mod listing;
mod naming;
mod publish;

#[cfg(test)]
mod fs_test;

pub(crate) use cli::{FsArgs, run};
