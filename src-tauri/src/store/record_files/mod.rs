//! Synchronized record persistence, split by cohesion out of the former
//! single-file `record_files.rs`. Every item previously reachable as
//! `crate::store::record_files::*` is re-exported below unchanged.

mod causal;
mod fingerprints;
mod io;
mod merge;
mod model;
mod payload;

#[cfg(test)]
#[path = "../tests/record_files_helpers.rs"]
mod record_files_helpers;

#[cfg(test)]
mod tests;

pub(crate) use causal::*;
pub(crate) use fingerprints::*;
pub(crate) use io::*;
pub(crate) use merge::*;
pub(crate) use model::*;
pub(crate) use payload::*;
